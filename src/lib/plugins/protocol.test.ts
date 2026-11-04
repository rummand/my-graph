import { describe, expect, it } from "vitest";
import path from "node:path";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { installedPlugins, pluginsDir, readPlugin } from "./manifest";
import { eventChange, externalIdOf, redactAll, safeUrl, sourceFor, stringLeaves } from "./mapping";
import { MAX_LINE, parseLine, secretKeys, uriKeys, validateConfig, type ConnectionSpec } from "./protocol";

describe("parsing plugin messages", () => {
  it("reads each message type", () => {
    const lines = [
      { type: "SPEC", spec: { protocolVersion: 1, name: "x", version: "1", connectionSpecification: { type: "object", properties: { url: { type: "string", format: "uri" } } } } },
      { type: "CONNECTION_STATUS", connectionStatus: { status: "SUCCEEDED" } },
      { type: "CATALOG", catalog: { streams: [{ name: "items", maps: "document" }] } },
      { type: "RECORD", record: { stream: "items", key: "a", data: { title: "Hello", url: "https://x.example" } } },
      { type: "STATE", state: { stream: "items", cursor: { seen: ["a"] } } },
      { type: "LOG", log: { level: "warn", message: "careful" } },
      { type: "TRACE", trace: { type: "error", error: { message: "no", failureType: "config_error" } } },
    ];
    for (const l of lines) {
      const r = parseLine(JSON.stringify(l));
      expect(r.ok && r.message?.type).toBe(l.type);
    }
  });
  it("skips blank lines and refuses anything else", () => {
    expect(parseLine("   ")).toEqual({ ok: true, message: null });
    expect(parseLine("hello")).toMatchObject({ ok: false });
    expect(parseLine(JSON.stringify({ type: "RECORD", record: { stream: "Items!", key: "a", data: { title: "x" } } }))).toMatchObject({ ok: false });
    expect(parseLine(JSON.stringify({ type: "RECORD", record: { stream: "items", key: "a", data: {} } }))).toMatchObject({ ok: false });
    expect(parseLine(JSON.stringify({ type: "SPEC", spec: { protocolVersion: 2, name: "x", version: "1", connectionSpecification: { type: "object", properties: {} } } }))).toMatchObject({ ok: false });
    expect(parseLine(JSON.stringify({ type: "EXEC", command: "rm -rf /" }))).toMatchObject({ ok: false });
    expect(parseLine("x".repeat(MAX_LINE + 1))).toMatchObject({ ok: false });
  });
});

describe("settings against the plugin's specification", () => {
  const spec: ConnectionSpec = {
    type: "object", required: ["url"], additionalProperties: false,
    properties: {
      url: { type: "string", format: "uri" }, maxItems: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      token: { type: "string", secret: true }, tags: { type: "array", items: { type: "string" } }, on: { type: "boolean" },
    },
  };
  it("applies defaults and coerces", () => {
    expect(validateConfig(spec, { url: "https://x.example", tags: "a, b", on: "true" })).toEqual({ ok: true, config: { url: "https://x.example", maxItems: 5, tags: ["a", "b"], on: true } });
  });
  it("names every problem", () => {
    const r = validateConfig(spec, { maxItems: 99, url: "not a url", extra: 1 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems.map((p) => p.key).sort()).toEqual(["extra", "maxItems", "url"]);
    expect(validateConfig(spec, {})).toMatchObject({ ok: false, problems: [{ key: "url", message: "is needed" }] });
  });
  it("knows which settings are secret and which are web addresses", () => {
    expect(secretKeys(spec)).toEqual(["token"]);
    expect(uriKeys(spec)).toEqual(["url"]);
  });
});

describe("records become sources with provenance", () => {
  it("dedupes by plugin, stream and key, and keeps only http(s) links", () => {
    expect(externalIdOf("rss", "items", "a")).toBe(externalIdOf("rss", "items", "a"));
    expect(externalIdOf("rss", "items", "a")).not.toBe(externalIdOf("rss", "other", "a"));
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("file:///etc/passwd")).toBeNull();
    const s = sourceFor({ pluginId: "rss", pluginName: "RSS", stream: "items", maps: "document", key: "a", fetchedAt: new Date("2026-11-04T10:00:00Z"),
      data: { title: "  Juleklip\n& gløgg ", text: "Kom og klip", url: "https://skole.example/a", date: "2026-11-03T10:00:00Z", author: "Lise" } });
    expect(s).toMatchObject({ title: "Juleklip & gløgg", url: "https://skole.example/a", documentDatePrecision: "minute", meta: { plugin: "rss", stream: "items", author: "Lise" } });
    expect(s.documentDate?.toISOString()).toBe("2026-11-03T10:00:00.000Z");
    expect(s.textContent).toContain("Kom og klip");
  });
  it("proposes an event with a receipt pointing at its source", () => {
    const ops = eventChange({ data: { title: "Skolefest", start: "2026-11-20T17:00:00Z", location: "Hallen" }, sourceId: "s1", nodeId: "n1", nodeExists: false, visibility: "household", label: "School feed", personNodeId: "p1" });
    expect(ops.map((o) => o.op)).toEqual(["addNode", "addEdge"]);
    expect(ops[0]).toMatchObject({ nodeId: "n1", type: "event", receipt: { sourceId: "s1" } });
    expect(eventChange({ data: { title: "No date" }, sourceId: "s", nodeId: "n", nodeExists: false, visibility: "private", label: "x" })).toEqual([]);
    expect(eventChange({ data: { title: "Moved", start: "2026-11-21T17:00:00Z" }, sourceId: "s", nodeId: "n", nodeExists: true, visibility: "private", label: "x" })[0].op).toBe("updateNode");
  });
  it("redacts every secret value from log lines", () => {
    const secrets = stringLeaves({ token: "s3cr3t-token", nested: { pw: "hunter22" }, short: "ab" });
    expect(secrets).toEqual(["s3cr3t-token", "hunter22"]);
    expect(redactAll("auth s3cr3t-token failed for hunter22", secrets)).toBe("auth ••• failed for •••");
  });
});

describe("installed plugins", () => {
  it("finds the example plugin in development, and nothing in production unless configured", () => {
    const cwd = path.resolve(__dirname, "../../..");
    const dev = installedPlugins({ NODE_ENV: "development" }, cwd);
    expect(dev.plugins.map((p) => p.id)).toContain("rss");
    expect(pluginsDir({ NODE_ENV: "production" }, cwd)).toBeNull();
    expect(installedPlugins({ NODE_ENV: "production" }, cwd).plugins).toEqual([]);
  });
  it("refuses an entry outside the plugin's folder (also through a symlink)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "mg-plugins-"));
    const a = path.join(root, "a");
    mkdirSync(a);
    writeFileSync(path.join(a, "plugin.json"), JSON.stringify({ id: "evil", name: "x", version: "1", protocol: 1, runtime: "node", entry: "../../etc/passwd" }));
    expect(() => readPlugin(a)).toThrow();
    const b = path.join(root, "b");
    mkdirSync(b);
    writeFileSync(path.join(root, "outside.mjs"), "");
    symlinkSync(path.join(root, "outside.mjs"), path.join(b, "index.mjs"));
    writeFileSync(path.join(b, "plugin.json"), JSON.stringify({ id: "sneaky", name: "x", version: "1", protocol: 1, runtime: "node", entry: "index.mjs" }));
    expect(() => readPlugin(b)).toThrow(/outside/);
    const listed = installedPlugins({ MG_PLUGINS_DIR: root }, "/");
    expect(listed.plugins).toEqual([]);
    expect(listed.problems).toHaveLength(2);
  });
});
