import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { complete, completeJson, embed, muxHealth, MuxAuthError, MuxError, MuxUnavailableError, stream, transcribe, whisperLanguage } from "./index";
import { buildHeaders, effectiveRoute, extractJson, muxConfig } from "./request";

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];

function mockFetch(...responses: (Response | Error | ((c: Call) => Response))[]) {
  calls = [];
  const queue = [...responses];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(call) : next;
  }));
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const sseBody = (parts: string[]) => new ReadableStream<Uint8Array>({
  start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); },
});

const meta = { userId: "u1", agent: "test-agent", traceId: "t1" };
const headersOf = (c: Call) => c.init.headers as Record<string, string>;
const bodyOf = (c: Call) => JSON.parse(String(c.init.body));

beforeEach(() => {
  vi.stubEnv("MUX_BASE_URL", "http://mux.test/");
  vi.stubEnv("MUX_API_KEY", "mux-sk-test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("request helpers", () => {
  it("reads config and trims the base URL", () => {
    expect(muxConfig({ MUX_BASE_URL: "http://x:1//", MUX_API_KEY: " k " })).toEqual({ baseUrl: "http://x:1", apiKey: "k" });
    expect(muxConfig({}).baseUrl).toBe("http://127.0.0.1:7070");
  });

  it("keeps sensitive work on the local agent route", () => {
    expect(effectiveRoute("smart", true)).toBe("agent");
    expect(effectiveRoute("fast", true)).toBe("agent");
    expect(effectiveRoute("vision", true)).toBe("vision");
    expect(effectiveRoute("smart", false)).toBe("smart");
  });

  it("builds mux headers; sensitive adds no-fallback and the tag", () => {
    const h = buildHeaders({ ...meta, sensitive: true }, "k");
    expect(h).toMatchObject({ "x-mux-agent": "test-agent", "x-mux-user": "u1", "x-mux-trace-id": "t1", "x-mux-no-fallback": "1", authorization: "Bearer k" });
    expect(h["x-mux-tags"].split(",")).toEqual(["my-graph", "sensitive"]);
    const plain = buildHeaders({ userId: "u", agent: "a" }, "");
    expect(plain["x-mux-no-fallback"]).toBeUndefined();
    expect(plain.authorization).toBeUndefined();
    expect(plain["x-mux-trace-id"]).toBeUndefined();
  });

  it("extracts JSON from fences, think blocks and prose", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('<think>hmm {"no":1}</think>Here: {"a":3} done')).toEqual({ a: 3 });
    expect(() => extractJson("no json here")).toThrow(SyntaxError);
  });
});

describe("complete", () => {
  it("posts an OpenAI chat request with mux headers and reads mux's response headers", async () => {
    mockFetch(json({ choices: [{ message: { content: "Hej" } }] }, 200, { "x-mux-model": "qwen", "x-mux-route": "fast", "x-mux-request-id": "r1" }));
    const r = await complete({ route: "fast", messages: [{ role: "user", content: "Hi" }], maxTokens: 50, temperature: 0, json: true, meta });
    expect(r).toEqual({ text: "Hej", model: "qwen", route: "fast", requestId: "r1" });
    expect(calls[0].url).toBe("http://mux.test/v1/chat/completions");
    expect(bodyOf(calls[0])).toMatchObject({ model: "fast", max_tokens: 50, temperature: 0, response_format: { type: "json_object" }, user: "u1" });
    expect(headersOf(calls[0])).toMatchObject({ authorization: "Bearer mux-sk-test", "x-mux-agent": "test-agent" });
  });

  it("sends sensitive requests to the local route without fallback", async () => {
    mockFetch(json({ choices: [{ message: { content: "ok" } }] }));
    await complete({ route: "smart", messages: [{ role: "user", content: "x" }], meta: { ...meta, sensitive: true } });
    expect(bodyOf(calls[0]).model).toBe("agent");
    expect(headersOf(calls[0])["x-mux-no-fallback"]).toBe("1");
    expect(headersOf(calls[0])["x-mux-tags"]).toContain("sensitive");
  });

  it("strips a leading <think> block", async () => {
    mockFetch(json({ choices: [{ message: { content: "<think>reasoning</think>\nAnswer" } }] }));
    expect((await complete({ route: "fast", messages: [], meta })).text).toBe("Answer");
  });

  it("throws MuxAuthError without calling mux when no key is configured", async () => {
    vi.stubEnv("MUX_API_KEY", "");
    mockFetch();
    await expect(complete({ route: "fast", messages: [], meta })).rejects.toMatchObject({ name: "MuxAuthError", type: "not_configured" });
    expect(calls).toHaveLength(0);
  });

  it("maps 401 to MuxAuthError, 503 to MuxUnavailableError, network failures to MuxUnavailableError, 429 to MuxError", async () => {
    mockFetch(json({ error: { message: "a mux API key is required", type: "invalid_api_key", code: 401 } }, 401, { "x-mux-request-id": "r9" }));
    const e1 = await complete({ route: "fast", messages: [], meta }).catch((e) => e);
    expect(e1).toBeInstanceOf(MuxAuthError);
    expect(e1.requestId).toBe("r9");

    mockFetch(json({ error: { message: "no model", type: "no_model", code: 503 } }, 503));
    await expect(complete({ route: "fast", messages: [], meta })).rejects.toBeInstanceOf(MuxUnavailableError);

    mockFetch(new TypeError("fetch failed"));
    await expect(complete({ route: "fast", messages: [], meta })).rejects.toBeInstanceOf(MuxUnavailableError);

    mockFetch(json({ error: { message: "slow down", type: "rate_limited", code: 429 } }, 429, { "retry-after": "5" }));
    const e4 = await complete({ route: "fast", messages: [], meta }).catch((e) => e);
    expect(e4).toBeInstanceOf(MuxError);
    expect(e4).not.toBeInstanceOf(MuxUnavailableError);
    expect(e4.retryAfterS).toBe(5);
  });
});

describe("stream", () => {
  it("yields content deltas and returns mux meta", async () => {
    const chunk = (t: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;
    mockFetch(new Response(sseBody([chunk("Hel"), chunk("lo") + 'data: {"choices":[{"delta":{}}]}\n\n', "data: [DONE]\n\n"]), {
      headers: { "content-type": "text/event-stream", "x-mux-model": "m", "x-mux-route": "smart", "x-mux-request-id": "r2" },
    }));
    const gen = stream({ route: "smart", messages: [{ role: "user", content: "x" }], meta });
    const parts: string[] = [];
    let r = await gen.next();
    while (!r.done) { parts.push(r.value); r = await gen.next(); }
    expect(parts.join("")).toBe("Hello");
    expect(r.value).toEqual({ model: "m", route: "smart", requestId: "r2" });
    expect(bodyOf(calls[0]).stream).toBe(true);
  });

  it("throws the error mux sends as the last event mid-stream", async () => {
    mockFetch(new Response(sseBody([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Par" } }] })}\n\n`,
      `data: ${JSON.stringify({ error: { message: "model crashed", type: "upstream_error", code: 502 } })}\n\n`,
    ]), { headers: { "content-type": "text/event-stream" } }));
    const got: string[] = [];
    await expect((async () => { for await (const t of stream({ route: "fast", messages: [], meta })) got.push(t); })()).rejects.toBeInstanceOf(MuxError);
    expect(got).toEqual(["Par"]);
  });

  it("fails before any text with MuxAuthError on 401", async () => {
    mockFetch(json({ error: { message: "bad key", type: "invalid_api_key" } }, 401));
    await expect(stream({ route: "fast", messages: [], meta }).next()).rejects.toBeInstanceOf(MuxAuthError);
  });
});

describe("completeJson", () => {
  it("retries once with the error appended, then returns the parsed value", async () => {
    mockFetch(
      json({ choices: [{ message: { content: "not json" } }] }),
      json({ choices: [{ message: { content: '{"n": 2}' } }] }),
    );
    const parse = (v: unknown) => {
      const n = (v as { n?: unknown }).n;
      if (typeof n !== "number") throw new Error("n must be a number");
      return n;
    };
    expect(await completeJson({ route: "agent", messages: [{ role: "user", content: "give n" }], parse, meta })).toBe(2);
    expect(calls).toHaveLength(2);
    const second = bodyOf(calls[1]);
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]).toEqual({ role: "assistant", content: "not json" });
    expect(second.messages[2].content).toContain("no JSON");
    expect(second.response_format).toEqual({ type: "json_object" });
  });

  it("also retries when the caller's parser rejects valid JSON, and gives up after one retry", async () => {
    mockFetch(json({ choices: [{ message: { content: '{"n":"x"}' } }] }), json({ choices: [{ message: { content: '{"n":"y"}' } }] }));
    const parse = (v: unknown) => { if (typeof (v as { n: unknown }).n !== "number") throw new Error("n must be a number"); return 1; };
    await expect(completeJson({ route: "agent", messages: [], parse, meta })).rejects.toThrow("n must be a number");
    expect(bodyOf(calls[1]).messages.at(-1).content).toContain("n must be a number");
  });
});

describe("embed", () => {
  it("embeds with the embed route and orders by index", async () => {
    mockFetch(json({ data: [{ index: 1, embedding: [0.2] }, { index: 0, embedding: [0.1] }] }));
    expect(await embed(["a", "b"], meta)).toEqual([[0.1], [0.2]]);
    expect(bodyOf(calls[0])).toMatchObject({ model: "embed", input: ["a", "b"] });
  });

  it("returns null when mux is down or not configured, [] for no input", async () => {
    mockFetch(new TypeError("fetch failed"));
    expect(await embed(["a"], meta)).toBeNull();
    vi.stubEnv("MUX_API_KEY", "");
    mockFetch();
    expect(await embed(["a"], meta)).toBeNull();
    expect(await embed([], meta)).toEqual([]);
  });
});

describe("transcribe", () => {
  it("sends multipart with the transcribe route and returns segments", async () => {
    mockFetch(json({ text: " Hej med dig ", segments: [{ start: 0, end: 1.5, text: " Hej" }, { start: 1.5, end: 3, text: " med dig" }] }));
    const r = await transcribe(new Blob(["abc"], { type: "audio/mpeg" }), "note.mp3", meta);
    expect(r).toEqual({ text: "Hej med dig", segments: [{ start: 0, end: 1.5, text: "Hej" }, { start: 1.5, end: 3, text: "med dig" }] });
    const form = calls[0].init.body as FormData;
    expect(form.get("model")).toBe("transcribe");
    expect(form.get("response_format")).toBe("verbose_json");
    expect((form.get("file") as File).name).toBe("note.mp3");
    expect(headersOf(calls[0])["content-type"]).toBeUndefined();
    expect(form.get("language")).toBeNull(); // no language given: Whisper detects it
  });

  it("passes the chosen language to Whisper", async () => {
    mockFetch(json({ text: "Hej" }));
    await transcribe(new Blob(["abc"], { type: "audio/webm" }), "d.webm", meta, { language: "da" });
    expect((calls[0].init.body as FormData).get("language")).toBe("da");
    mockFetch(json({ text: "Hi" }));
    await transcribe(new Blob(["abc"], { type: "audio/webm" }), "d.webm", meta, { language: "en-GB" });
    expect((calls[0].init.body as FormData).get("language")).toBe("en");
  });

  it("only sends a language Whisper understands", () => {
    expect(whisperLanguage("da")).toBe("da");
    expect(whisperLanguage("da-DK")).toBe("da");
    expect(whisperLanguage("EN_gb")).toBe("en");
    expect(whisperLanguage("danish")).toBeNull();
    expect(whisperLanguage("")).toBeNull();
    expect(whisperLanguage(null)).toBeNull();
  });
});

describe("muxHealth", () => {
  it("reports reachable + configured, and degrades without throwing", async () => {
    mockFetch(json({ ok: true, models: 3, loaded: ["qwen"] }));
    expect(await muxHealth({ fresh: true })).toMatchObject({ ok: true, reachable: true, configured: true, loaded: ["qwen"] });

    vi.stubEnv("MUX_API_KEY", "");
    mockFetch(json({ ok: true }));
    expect(await muxHealth({ fresh: true })).toMatchObject({ ok: false, reachable: true, configured: false });

    mockFetch(new TypeError("fetch failed"));
    expect(await muxHealth({ fresh: true })).toMatchObject({ ok: false, reachable: false });
  });
});
