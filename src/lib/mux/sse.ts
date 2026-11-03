/**
 * Server-Sent Events parsing (pure; safe to import from client components).
 * Handles events split across network chunks, CRLF/CR/LF line endings, multi-line `data:` fields, comments
 * (`: keep-alive`) and a final event without a trailing blank line (on `flush()`).
 */
export type SseEvent = { event: string; data: string; id?: string };

export class SseParser {
  private buf = "";
  private data: string[] = [];
  private event = "";
  private id: string | undefined;
  private sawField = false;

  /** Feed text; returns every event completed by it. */
  push(text: string): SseEvent[] {
    this.buf += text;
    const out: SseEvent[] = [];
    // A line ends at \r\n, \n or \r. A trailing lone \r may be the first half of \r\n, so wait for more input.
    for (;;) {
      const m = /\r\n|\n|\r/.exec(this.buf);
      if (!m) break;
      if (m[0] === "\r" && m.index === this.buf.length - 1) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  /** End of stream: the last event, if it wasn't followed by a blank line. */
  flush(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buf) {
      const ev = this.line(this.buf.replace(/\r$/, ""));
      this.buf = "";
      if (ev) out.push(ev);
    }
    const last = this.dispatch();
    if (last) out.push(last);
    return out;
  }

  private line(line: string): SseEvent | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") { this.data.push(value); this.sawField = true; }
    else if (field === "event") { this.event = value; this.sawField = true; }
    else if (field === "id") { this.id = value; this.sawField = true; }
    return null;
  }

  private dispatch(): SseEvent | null {
    if (!this.sawField) return null;
    const ev: SseEvent = { event: this.event || "message", data: this.data.join("\n") };
    if (this.id !== undefined) ev.id = this.id;
    this.data = [];
    this.event = "";
    this.sawField = false;
    return ev;
  }
}

/** Parse a complete SSE text (tests, small bodies). */
export function parseSse(text: string): SseEvent[] {
  const p = new SseParser();
  return [...p.push(text), ...p.flush()];
}

/** Read a byte stream as SSE events. Cancels the stream when the consumer stops early. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let done = false;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      for (const ev of parser.push(decoder.decode(r.value, { stream: true }))) yield ev;
    }
    const tail = decoder.decode();
    for (const ev of parser.push(tail)) yield ev;
    for (const ev of parser.flush()) yield ev;
    done = true;
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Format one SSE event (for our own /api/chat stream). */
export function formatSse(event: string, data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `event: ${event}\n${payload.split(/\r\n|\n|\r/).map((l) => `data: ${l}`).join("\n")}\n\n`;
}
