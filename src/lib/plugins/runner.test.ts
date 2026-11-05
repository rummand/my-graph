import { describe, expect, it } from "vitest";
import path from "node:path";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readPlugin } from "./manifest";
import { collect, pluginEnv, PluginRunError, runPlugin } from "./runner";

/** A throwaway plugin whose index.mjs is `code`. */
function fixture(code: string, limits?: Record<string, number>) {
  const dir = mkdtempSync(path.join(tmpdir(), "mg-plugin-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "index.mjs"), code);
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ id: "fixture", name: "Fixture", version: "1", protocol: 1, runtime: "node", entry: "index.mjs", ...(limits ? { limits } : {}) }));
  return readPlugin(dir);
}
const say = (m: unknown) => `process.stdout.write(JSON.stringify(${JSON.stringify(m)}) + "\\n");`;
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as PluginRunError; } throw new Error("expected a failure"); };

describe("the runner", () => {
  it("passes settings on stdin and streams the messages", async () => {
    const p = fixture(`let d = ""; process.stdin.on("data", (c) => d += c); process.stdin.on("end", () => {
      const { config } = JSON.parse(d);
      process.stdout.write(JSON.stringify({ type: "LOG", log: { level: "info", message: "argv " + process.argv[2] + " url " + config.url } }) + "\\n");
      ${say({ type: "RECORD", record: { stream: "items", key: "1", data: { title: "One" } } })}
      ${say({ type: "STATE", state: { stream: "items", cursor: 1 } })}
    });`);
    const { messages, summary } = await collect(p, "read", { config: { url: "https://x.example" } });
    expect(messages.map((m) => m.type)).toEqual(["LOG", "RECORD", "STATE"]);
    expect(messages[0].type === "LOG" && messages[0].log.message).toBe("argv read url https://x.example");
    expect(summary.records).toBe(1);
    expect(summary.exitCode).toBe(0);
  });

  it("stops a plugin that runs too long (and everything it started)", async () => {
    const p = fixture(`${say({ type: "LOG", log: { level: "info", message: "starting" } })} setInterval(() => {}, 1000);`);
    const t0 = Date.now();
    const e = await err(collect(p, "read", { config: {} }, { limits: { timeoutMs: 600, idleMs: 10_000 } }));
    expect(e).toBeInstanceOf(PluginRunError);
    expect(e.failure).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("stops a plugin that goes quiet", async () => {
    const p = fixture(`setInterval(() => {}, 1000);`);
    expect((await err(collect(p, "read", { config: {} }, { limits: { timeoutMs: 10_000, idleMs: 400 } }))).failure).toBe("idle");
  });

  it("stops one that floods: too many records, too many bytes, a line too long", async () => {
    const flood = fixture(`for (let i = 0; i < 100; i++) ${say({ type: "RECORD", record: { stream: "items", key: "k", data: { title: "t" } } })}`);
    expect((await err(collect(flood, "read", { config: {} }, { limits: { maxRecords: 10 } }))).failure).toBe("limit");
    const big = fixture(`const s = "x".repeat(100000); for (let i = 0; i < 50; i++) process.stdout.write(JSON.stringify({ type: "LOG", log: { level: "info", message: s.slice(0, 3000) } }) + "\\n");`);
    expect((await err(collect(big, "read", { config: {} }, { limits: { maxBytes: 20_000 } }))).failure).toBe("limit");
    const line = fixture(`process.stdout.write("x".repeat(600 * 1024));`);
    expect((await err(collect(line, "read", { config: {} }))).failure).toBe("protocol");
  });

  it("refuses output that isn't the protocol, and reports a crash with its stderr (redacted)", async () => {
    const junk = fixture(`console.log("hello there");`);
    expect((await err(collect(junk, "read", { config: {} }))).failure).toBe("protocol");
    const crash = fixture(`console.error("boom with s3cr3t"); process.exit(3);`);
    const e = await err(collect(crash, "read", { config: {} }, { redact: (s) => s.replaceAll("s3cr3t", "•••") }));
    expect(e.failure).toBe("crashed");
    expect(e.stderr).toContain("boom with •••");
    expect(e.stderr).not.toContain("s3cr3t");
  });

  it("caps a Node plugin's memory", async () => {
    const hog = fixture(`const a = []; while (true) a.push(new Array(1e6).fill(1));`, { memoryMb: 32 });
    const e = await err(collect(hog, "read", { config: {} }, { limits: { timeoutMs: 20_000 } }));
    expect(["crashed", "timeout"]).toContain(e.failure);
  }, 30_000);

  it("gives the plugin none of the server's environment", async () => {
    process.env.DATABASE_URL_TEST_LEAK = "postgres://secret";
    const p = fixture(`process.stdout.write(JSON.stringify({ type: "LOG", log: { level: "info", message: JSON.stringify(Object.keys(process.env).sort()) } }) + "\\n");`);
    const { messages } = await collect(p, "spec", { config: {} });
    const keys = JSON.parse(messages[0].type === "LOG" ? messages[0].log.message : "[]") as string[];
    expect(keys).not.toContain("DATABASE_URL_TEST_LEAK");
    expect(keys.filter((k) => !["PATH", "HOME", "TMPDIR", "LANG", "TZ", "NODE_ENV", "MG_PLUGIN_ID", "MG_PLUGIN_PROTOCOL", "MG_PLUGIN_NET", "MG_ALLOW_PRIVATE", "__CF_USER_TEXT_ENCODING"].includes(k))).toEqual([]);
    expect(Object.keys(pluginEnv({ id: "x" }))).not.toContain("DATABASE_URL");
  });

  it("is stopped by the run's signal, and when the consumer stops reading", async () => {
    const p = fixture(`setInterval(() => { ${say({ type: "LOG", log: { level: "info", message: "tick" } })} }, 50);`);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    expect((await err(collect(p, "read", { config: {} }, { signal: ac.signal }))).failure).toBe("aborted");
    let n = 0;
    for await (const m of runPlugin(p, "read", { config: {} })) { if (m.type === "LOG" && ++n === 2) break; }
    expect(n).toBe(2);
  });
});

describe("the example RSS plugin, through the runner", () => {
  it("reads a feed into records and a cursor", async () => {
    const plugin = readPlugin(path.resolve(__dirname, "../../../examples/plugin-rss"));
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><item><title>A</title><guid>a</guid><link>https://e.example/a</link></item></channel></rss>`;
    const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/rss+xml" }); res.end(feed); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const prev = process.env.CONNECTORS_ALLOW_PRIVATE;
    process.env.CONNECTORS_ALLOW_PRIVATE = "1";
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/f`;
      const { messages } = await collect(plugin, "read", { config: { url, maxItems: 10 } });
      expect(messages.map((m) => m.type)).toEqual(["LOG", "RECORD", "STATE"]);
      const check = await collect(plugin, "check", { config: { url } });
      expect(check.messages[0]).toMatchObject({ type: "CONNECTION_STATUS", connectionStatus: { status: "SUCCEEDED" } });
    } finally {
      process.env.CONNECTORS_ALLOW_PRIVATE = prev;
      server.close();
    }
  });
});
