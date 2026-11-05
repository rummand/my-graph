import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { installedPlugins, readPlugin } from "./manifest";
import { collect, PluginRunError } from "./runner";
import { hostAllowed, networkEnv, sandboxPlan, sandboxUser } from "./sandbox";

/** A throwaway Node plugin: `code` runs, then reports `out` (an object it filled in) as one LOG line. */
function fixture(code: string, manifest: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mg-sandbox-"));
  writeFileSync(path.join(dir, "index.mjs"), `const out = {};\n${code}\nprocess.stdout.write(JSON.stringify({ type: "LOG", log: { level: "info", message: JSON.stringify(out) } }) + "\\n");`);
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ id: "fixture", name: "Fixture", version: "1", protocol: 1, runtime: "node", entry: "index.mjs", ...manifest }));
  return readPlugin(dir);
}
async function report(p: ReturnType<typeof fixture>, limits = {}): Promise<Record<string, unknown>> {
  const { messages } = await collect(p, "read", { config: {} }, { limits });
  const m = messages.find((x) => x.type === "LOG");
  return JSON.parse(m && m.type === "LOG" ? m.log.message : "{}") as Record<string, unknown>;
}
const tryIt = (key: string, body: string) => `try { ${body}; out.${key} = "allowed"; } catch (e) { out.${key} = e.code || e.cause?.code || e.message; }`;

let server: Server;
let url = "";
beforeAll(async () => {
  server = createServer((_q, r) => r.end("hello"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => { server.close(); });

describe("the plugin sandbox (Node permission model)", () => {
  it("reads only its own folder; no writing, no other programs, no worker threads", async () => {
    const p = fixture([
      `import fs from "node:fs";`,
      tryIt("own", `fs.readFileSync(new URL("./plugin.json", import.meta.url))`),
      tryIt("etc", `fs.readFileSync("/etc/hosts")`),
      tryIt("write", `fs.writeFileSync(new URL("./x.txt", import.meta.url), "x")`),
      tryIt("child", `(await import("node:child_process")).execSync("echo hi")`),
      tryIt("worker", `new (await import("node:worker_threads")).Worker("1", { eval: true })`),
      tryIt("binding", `process.binding("tcp_wrap")`),
      tryIt("evalStr", `new Function("return 1")()`),
    ].join("\n"));
    expect(await report(p)).toEqual({
      own: "allowed", etc: "ERR_ACCESS_DENIED", write: "ERR_ACCESS_DENIED", child: "ERR_ACCESS_DENIED", worker: "ERR_ACCESS_DENIED",
      binding: "ERR_ACCESS_DENIED", evalStr: "Code generation from strings disallowed for this context",
    });
  });

  it("has no network unless plugin.json declares it, and can't take the guard off", async () => {
    const code = [
      `import net from "node:net";`,
      `try { await fetch(${JSON.stringify("URL")}); out.fetch = "allowed"; } catch (e) { out.fetch = e.cause?.code || e.code || e.message; }`,
      tryIt("reassign", `net.Socket.prototype.connect = function () {}`),
      tryIt("listen", `net.createServer().listen(0)`),
      tryIt("udp", `(await import("node:dgram")).createSocket("udp4")`),
      `try { await (await import("node:dns")).promises.lookup("example.com"); out.dns = "allowed"; } catch (e) { out.dns = e.code; }`,
    ].join("\n");
    const none = fixture(code.replace('"URL"', JSON.stringify(url)));
    expect(await report(none)).toMatchObject({ fetch: "ERR_ACCESS_DENIED", reassign: expect.stringMatching(/read only|read-only/), listen: "ERR_ACCESS_DENIED", udp: "ERR_ACCESS_DENIED", dns: "ERR_ACCESS_DENIED" });
  });

  it("network: true is the public internet only: private addresses are refused (unless development allows them)", async () => {
    const p = fixture(`try { const r = await fetch(${JSON.stringify(url)}); out.fetch = await r.text(); } catch (e) { out.fetch = e.cause?.code || e.message; }`, { network: true });
    const prev = process.env.CONNECTORS_ALLOW_PRIVATE;
    const prevEnv = process.env.NODE_ENV;
    try {
      process.env.CONNECTORS_ALLOW_PRIVATE = "0";
      (process.env as Record<string, string>).NODE_ENV = "production";
      expect(await report(p)).toEqual({ fetch: "ERR_ACCESS_DENIED" });
      process.env.CONNECTORS_ALLOW_PRIVATE = "1";
      (process.env as Record<string, string>).NODE_ENV = "test";
      expect(await report(p)).toEqual({ fetch: "hello" });
    } finally {
      process.env.CONNECTORS_ALLOW_PRIVATE = prev;
      (process.env as Record<string, string | undefined>).NODE_ENV = prevEnv;
    }
  });

  it("a host list allows only those hosts", async () => {
    const p = fixture(`try { await fetch(${JSON.stringify(url)}); out.fetch = "allowed"; } catch (e) { out.fetch = e.cause?.code || e.message; }`, { network: ["feeds.example.com"] });
    const prev = process.env.CONNECTORS_ALLOW_PRIVATE;
    process.env.CONNECTORS_ALLOW_PRIVATE = "1";
    try {
      expect(await report(p)).toEqual({ fetch: "ERR_ACCESS_DENIED" });
    } finally {
      process.env.CONNECTORS_ALLOW_PRIVATE = prev;
    }
    expect(hostAllowed("feeds.example.com", ["feeds.example.com"])).toBe(true);
    expect(hostAllowed("a.example.org", ["*.example.org"])).toBe(true);
    expect(hostAllowed("example.org", ["*.example.org"])).toBe(false);
    expect(hostAllowed("evil-example.org", ["*.example.org"])).toBe(false);
  });

  it("is stopped when it uses too much processor time", async () => {
    const p = fixture(`const t = Date.now(); while (Date.now() - t < 20000) {}`);
    let e: unknown;
    try { await collect(p, "read", { config: {} }, { limits: { cpuSeconds: 1, timeoutMs: 15_000, idleMs: 15_000 } }); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(PluginRunError);
    expect((e as PluginRunError).failure).toBe("limit");
    expect((e as PluginRunError).message).toMatch(/processor time/);
  }, 20_000);
});

describe("the sandbox plan", () => {
  const base = { runtime: "node" as const, dir: "/plugins/rss", entryPath: "/plugins/rss/index.mjs", command: "read", memoryMb: 128, cpuSeconds: 30, env: { PATH: "/bin" } };

  it("starts Node with the permission model, reading only the plugin folder and the guard, under ulimit", () => {
    const plan = sandboxPlan(base, { env: {}, shell: "/bin/sh", nodePath: "/usr/bin/node", guard: "/tmp/guard.cjs", uid: 1000 });
    expect(plan.cmd).toBe("/bin/sh");
    expect(plan.args.slice(2, 4)).toEqual(["30", String(200 * 1024 * 2)]);
    const node = plan.args.slice(plan.args.indexOf("/usr/bin/node"));
    expect(node).toEqual(["/usr/bin/node", "--permission", "--allow-fs-read=/plugins/rss", "--allow-fs-read=/tmp/guard.cjs", "--max-old-space-size=128", "--disallow-code-generation-from-strings", "--require", "/tmp/guard.cjs", "/plugins/rss/index.mjs", "read"]);
    expect(node.join(" ")).not.toMatch(/allow-child-process|allow-worker|allow-fs-write|allow-addons|allow-wasi/);
    expect(plan.env).toEqual({ PATH: "/bin", MG_PLUGIN_NET: "none" });
    expect(plan.uid).toBeUndefined();
  });

  it("runs as another user when the server is root", () => {
    expect(sandboxUser({}, 0)).toEqual({ uid: 65534, gid: 65534 });
    expect(sandboxUser({ MG_PLUGIN_UID: "1500", MG_PLUGIN_GID: "1500" }, 0)).toEqual({ uid: 1500, gid: 1500 });
    expect(sandboxUser({ MG_PLUGIN_UID: "0" }, 0)).toEqual({ uid: 65534, gid: 65534 }); // never root
    expect(sandboxUser({}, 501)).toBeNull();
    const plan = sandboxPlan(base, { env: {}, shell: "/bin/sh", nodePath: "node", guard: "/g.cjs", uid: 0 });
    expect([plan.uid, plan.gid]).toEqual([65534, 65534]);
  });

  it("refuses executable plugins unless the admin turned them on", () => {
    expect(() => sandboxPlan({ ...base, runtime: "executable" }, { env: {}, shell: null, uid: 1 })).toThrow(/turned off/);
    const plan = sandboxPlan({ ...base, runtime: "executable" }, { env: { MG_PLUGINS_ALLOW_EXECUTABLE: "1" }, shell: null, uid: 1 });
    expect(plan.cmd).toBe("/plugins/rss/index.mjs");
  });

  it("lists executable plugins only when they are turned on", () => {
    const root = mkdtempSync(path.join(tmpdir(), "mg-plugins-"));
    const dir = path.join(root, "sh");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "run.sh"), "#!/bin/sh\necho");
    chmodSync(path.join(dir, "run.sh"), 0o755);
    writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ id: "shell", name: "Shell", version: "1", protocol: 1, runtime: "executable", entry: "run.sh" }));
    const off = installedPlugins({ MG_PLUGINS_DIR: root });
    expect(off.plugins).toHaveLength(0);
    expect(off.problems[0]).toMatch(/turned off/);
    expect(installedPlugins({ MG_PLUGINS_DIR: root, MG_PLUGINS_ALLOW_EXECUTABLE: "1" }).plugins.map((p) => p.id)).toEqual(["shell"]);
  });

  it("network settings: none by default, the proxy only for plugins with network", () => {
    expect(networkEnv(undefined)).toEqual({ MG_PLUGIN_NET: "none" });
    expect(networkEnv(false, { MG_PLUGINS_PROXY: "http://proxy:3128" })).toEqual({ MG_PLUGIN_NET: "none" });
    expect(networkEnv(["a.example.com"])).toEqual({ MG_PLUGIN_NET: "hosts", MG_PLUGIN_NET_HOSTS: "a.example.com" });
    expect(networkEnv(true, { MG_PLUGINS_PROXY: "http://proxy:3128" })).toMatchObject({ MG_PLUGIN_NET: "public", HTTPS_PROXY: "http://proxy:3128" });
  });
});
