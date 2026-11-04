import { describe, expect, it } from "vitest";
import { validateManifest } from "../manifest";
import { deps, fakeApi, fakeCtx, memorySink, runLikeTheApp } from "../oauth/testing";
import { dropboxConfig, dropboxManifest, syncDropbox } from "./connector";
import { apiArg, dropboxConflict, dropboxFiles, dropboxVersion } from "./map";

describe("dropbox mapping", () => {
  it("is a valid manifest", () => expect(validateManifest(dropboxManifest)).toEqual({ ok: true }));

  it("sorts 409 answers into reset, not found and other", () => {
    expect(dropboxConflict(409, JSON.stringify({ error_summary: "reset/..", error: { ".tag": "reset" } }))).toBe("reset");
    expect(dropboxConflict(409, JSON.stringify({ error_summary: "path/not_found/.." }))).toBe("notFound");
    expect(dropboxConflict(409, "{}")).toBe("other");
    expect(dropboxConflict(200, "")).toBeNull();
  });

  it("keeps files, versions them by content hash, and writes the API header as ASCII", () => {
    expect(dropboxFiles([{ ".tag": "file", id: "id:1", name: "a" }, { ".tag": "folder", id: "id:2", name: "b" }, { ".tag": "deleted", name: "c" }]).map((e) => e.id)).toEqual(["id:1"]);
    expect(dropboxVersion({ ".tag": "file", name: "a", rev: "r", content_hash: "h" })).toBe("h");
    expect(apiArg({ path: "/Børn/æble.pdf" })).toBe('{"path":"/B\\u00f8rn/\\u00e6ble.pdf"}');
  });
});

function dropboxServer() {
  const s = { reset: false, more: [] as unknown[] };
  const api = fakeApi(({ u, body, headers }) => {
    if (u.pathname.endsWith("/2/files/list_folder")) {
      const b = JSON.parse(body ?? "{}") as { path: string; recursive: boolean };
      expect(b.recursive).toBe(true);
      return { json: { entries: [{ ".tag": "folder", id: "id:f", name: "Skole", path_lower: "/familie/skole" }, { ".tag": "file", id: "id:a", name: "Skema.pdf", content_hash: "h1", path_display: "/Familie/Skole/Skema.pdf" }], cursor: "c1", has_more: true } };
    }
    if (u.pathname.endsWith("/2/files/list_folder/continue")) {
      const b = JSON.parse(body ?? "{}") as { cursor: string };
      if (s.reset) return { status: 409, json: { error_summary: "reset/...", error: { ".tag": "reset" } } };
      if (b.cursor === "c1") return { json: { entries: [{ ".tag": "file", id: "id:b", name: "Billede.jpg", content_hash: "h2" }], cursor: "c2", has_more: false } };
      return { json: { entries: s.more, cursor: `${b.cursor}+`, has_more: false } };
    }
    if (u.pathname.endsWith("/2/files/download")) {
      const arg = JSON.parse(headers?.["dropbox-api-arg"] ?? "{}") as { path: string };
      return { body: arg.path === "id:b" ? Buffer.from([0xff, 0xd8, 0xff, 0xe0]) : Buffer.from("%PDF-1.4") };
    }
    return undefined;
  });
  return { api, s };
}

describe("dropbox sync", () => {
  const cfg = dropboxConfig.parse({ folders: [{ id: "id:fam", name: "Familie", path: "/familie" }] });

  it("lists the folder recursively the first time, then continues from the cursor", async () => {
    const d = dropboxServer();
    const sink = memorySink();
    const ctx = fakeCtx("dropbox", cfg);
    await runLikeTheApp(ctx, syncDropbox, deps(d.api, sink));
    expect(sink.rec.files.map((f) => [f.externalId, f.name])).toEqual([["dropbox:id:a", "Skema.pdf"], ["dropbox:id:b", "Billede.jpg"]]);
    expect(ctx.state().streams?.files?.cursor).toEqual({ folders: { "/familie": { cursor: "c2" } } });
    d.s.more = [{ ".tag": "file", id: "id:a", name: "Skema.pdf", content_hash: "h1" }, { ".tag": "file", id: "id:c", name: "Brev.pdf", content_hash: "h3" }];
    await runLikeTheApp(ctx, syncDropbox, deps(d.api, sink));
    expect(sink.rec.files.map((f) => f.externalId)).toEqual(["dropbox:id:a", "dropbox:id:b", "dropbox:id:c"]);
    expect(ctx.counts.files.unchanged).toBe(1);
  });

  it("lists again on a 409 reset, without downloading unchanged files", async () => {
    const d = dropboxServer();
    d.s.reset = true;
    const sink = memorySink();
    sink.rec.versions.set("dropbox:id:a", "h1");
    const ctx = fakeCtx("dropbox", cfg, { streams: { files: { cursor: { folders: { "/familie": { cursor: "stale" } } } } } });
    const r = await runLikeTheApp(ctx, async (c, dd) => { try { await syncDropbox(c, dd); } finally { d.s.reset = false; } }, deps(d.api, sink));
    expect(r.reset).toBe("files:reset");
    expect(sink.rec.files.map((f) => f.externalId)).toEqual(["dropbox:id:b"]);
    expect(d.api.calls.filter((c) => c.url.endsWith("/files/download"))).toHaveLength(1);
  });

  it("waits for a folder to be chosen", async () => {
    const d = dropboxServer();
    const ctx = fakeCtx("dropbox", dropboxConfig.parse({}));
    await syncDropbox(ctx, deps(d.api, memorySink()));
    expect(d.api.calls).toHaveLength(0);
  });
});
