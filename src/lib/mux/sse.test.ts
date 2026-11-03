import { describe, expect, it } from "vitest";
import { formatSse, parseSse, readSse, SseParser } from "./sse";

describe("SseParser", () => {
  it("parses OpenAI-style data events and [DONE]", () => {
    const evs = parseSse('data: {"a":1}\n\ndata: {"a":2}\n\ndata: [DONE]\n\n');
    expect(evs.map((e) => e.data)).toEqual(['{"a":1}', '{"a":2}', "[DONE]"]);
    expect(evs[0].event).toBe("message");
  });

  it("handles events split across chunks, including inside a line and between \\r and \\n", () => {
    const p = new SseParser();
    const out = [
      ...p.push("da"), ...p.push("ta: hel"), ...p.push("lo\r"), ...p.push("\n\r"), ...p.push("\n"),
      ...p.push("event: done\ndata: x\n"), ...p.push("\n"),
    ];
    expect(out).toEqual([{ event: "message", data: "hello" }, { event: "done", data: "x" }]);
  });

  it("joins multi-line data, ignores comments and unknown fields, keeps ids", () => {
    const evs = parseSse(": keep-alive\nretry: 10\nid: 7\nevent: delta\ndata: line 1\ndata: line 2\n\n");
    expect(evs).toEqual([{ event: "delta", data: "line 1\nline 2", id: "7" }]);
  });

  it("strips exactly one leading space and accepts fields without a colon", () => {
    expect(parseSse("data:  two\n\n")[0].data).toBe(" two");
    expect(parseSse("data\n\n")[0].data).toBe("");
  });

  it("flushes a final event without a trailing blank line", () => {
    const p = new SseParser();
    expect(p.push("data: tail")).toEqual([]);
    expect(p.flush()).toEqual([{ event: "message", data: "tail" }]);
  });

  it("does not emit events for blank lines alone", () => {
    expect(parseSse("\n\n\n")).toEqual([]);
  });
});

describe("readSse", () => {
  it("reads a byte stream with multi-byte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode('data: {"t":"Hej, Søren 👋"}\n\n');
    const cut = 18; // inside "ø"
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(bytes.slice(0, cut)); c.enqueue(bytes.slice(cut)); c.close(); },
    });
    const evs = [];
    for await (const e of readSse(body)) evs.push(e);
    expect(JSON.parse(evs[0].data).t).toBe("Hej, Søren 👋");
  });

  it("cancels the underlying stream when the consumer stops early", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(new TextEncoder().encode("data: x\n\n")); },
      cancel() { cancelled = true; },
    });
    for await (const _ of readSse(body)) break;
    expect(cancelled).toBe(true);
  });
});

describe("formatSse", () => {
  it("round-trips through the parser, including newlines in data", () => {
    const text = formatSse("delta", { text: "a\nb" }) + formatSse("raw", "line1\nline2");
    const evs = parseSse(text);
    expect(evs[0]).toEqual({ event: "delta", data: '{"text":"a\\nb"}' });
    expect(evs[1]).toEqual({ event: "raw", data: "line1\nline2" });
  });
});
