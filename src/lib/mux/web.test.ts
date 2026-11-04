import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MuxError, read, search, webResults } from "./index";

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
function mockFetch(...responses: Response[]) {
  calls = [];
  const queue = [...responses];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { calls.push({ url: String(url), init }); return queue.shift()!; }));
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const meta = { userId: "u1", agent: "my-graph:web", graphId: "g1" };

beforeEach(() => { vi.stubEnv("MUX_BASE_URL", "http://mux.test"); vi.stubEnv("MUX_API_KEY", "mux-sk-test"); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("mux web", () => {
  it("searches through /v1/search with the web tag", async () => {
    mockFetch(json({ object: "search", query: "q", results: [{ title: "A", url: "https://a.dk", snippet: "s", engine: "ddg", published: null }, { url: "javascript:x" }] }));
    const r = await search({ query: "Lindevang Skole", limit: 3, meta });
    expect(calls[0].url).toBe("http://mux.test/v1/search");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ query: "Lindevang Skole", limit: 3 });
    expect((calls[0].init.headers as Record<string, string>)["x-mux-tags"]).toContain("web");
    expect(r).toEqual([{ title: "A", url: "https://a.dk", snippet: "s", engine: "ddg", published: null }]);
  });
  it("reads through /v1/read", async () => {
    mockFetch(json({ object: "page", url: "https://a.dk/x", title: "X", text: "Hello" }));
    expect(await read({ url: "https://a.dk/x", maxChars: 5000, meta })).toEqual({ url: "https://a.dk/x", title: "X", text: "Hello" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ url: "https://a.dk/x", max_chars: 5000 });
  });
  it("throws when a page refuses (LinkedIn answers 999 → mux 502)", async () => {
    mockFetch(json({ error: { message: "the page answered 999", type: "upstream_error" } }, 502));
    await expect(read({ url: "https://linkedin.com/in/x", meta })).rejects.toBeInstanceOf(MuxError);
  });
  it("drops junk results", () => {
    expect(webResults(null)).toEqual([]);
    expect(webResults([{ url: "https://b.com" }])).toEqual([{ url: "https://b.com", title: "https://b.com", snippet: "", engine: null, published: null }]);
  });
});
