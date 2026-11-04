import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/docs/media/route";
import { FILM } from "./film";

// POST /api/docs/media against a temporary DOCS_MEDIA_DIR: the token, the allow-list, and that a good upload lands.
const dir = mkdtempSync(path.join(tmpdir(), "docs-media-"));
const TOKEN = "test-upload-token-0123456789";
const post = (name: string, body: string, auth?: string) =>
  POST(new Request(`http://x/api/docs/media?name=${encodeURIComponent(name)}`, {
    method: "POST", body, headers: auth ? { authorization: auth } : {},
  }));

beforeAll(() => { process.env.DOCS_MEDIA_DIR = dir; process.env.DOCS_UPLOAD_TOKEN = TOKEN; });
afterAll(() => { delete process.env.DOCS_MEDIA_DIR; delete process.env.DOCS_UPLOAD_TOKEN; rmSync(dir, { recursive: true, force: true }); });

describe("POST /api/docs/media", () => {
  it("refuses without the token, or with the wrong one", async () => {
    expect((await post(FILM.vtt, "WEBVTT")).status).toBe(401);
    expect((await post(FILM.vtt, "WEBVTT", "Bearer nope-nope-nope-nope")).status).toBe(401);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("refuses a name that isn't on the allow-list", async () => {
    for (const name of ["../escape.txt", "other.mp4", "", "index.html"]) {
      expect((await post(name, "x", `Bearer ${TOKEN}`)).status).toBe(400);
    }
    expect(readdirSync(dir)).toEqual([]);
  });
  it("refuses an empty upload", async () => {
    expect((await post(FILM.vtt, "", `Bearer ${TOKEN}`)).status).toBe(400);
    expect(readdirSync(dir)).toEqual([]);
  });
  it("stores an allowed file with the token", async () => {
    const res = await post(FILM.vtt, "WEBVTT\n\nhello", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, name: FILM.vtt, size: 13 });
    expect(readFileSync(path.join(dir, FILM.vtt), "utf8")).toBe("WEBVTT\n\nhello");
    expect(readdirSync(dir)).toEqual([FILM.vtt]);   // no temporary file left behind
  });
});
