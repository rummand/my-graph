/**
 * Minimal .eml reader. Pure. Pulls the headers people care about (subject, from, to, date) and the readable body:
 * the text/plain part when there is one, otherwise text/html with tags stripped. Handles multipart nesting,
 * quoted-printable, base64 and RFC 2047 encoded-word headers. Attachments are listed by name, not parsed.
 */

export type AttachmentPart = { filename: string; mime: string; bytes: Uint8Array };

export type ParsedEmail = {
  subject?: string; from?: string; to?: string; cc?: string; date?: Date; body: string; attachments: string[];
  /** Threading headers, angle brackets removed. */
  messageId?: string; inReplyTo?: string; references: string[];
  /** Decoded attachment bodies (only when asked for: they can be large). */
  attachmentParts: AttachmentPart[];
};

type Part = { headers: Record<string, string>; body: string };

function splitHeadersBody(raw: string): Part {
  const text = raw.replace(/\r\n/g, "\n");
  const idx = text.indexOf("\n\n");
  const head = idx >= 0 ? text.slice(0, idx) : text;
  const body = idx >= 0 ? text.slice(idx + 2) : "";
  const headers: Record<string, string> = {};
  let last = "";
  for (const line of head.split("\n")) {
    if (/^[ \t]/.test(line) && last) {
      headers[last] += " " + line.trim();
      continue;
    }
    const m = line.match(/^([!-9;-~]+):\s*(.*)$/);
    if (m) {
      last = m[1].toLowerCase();
      headers[last] = headers[last] ? headers[last] : m[2];
    }
  }
  return { headers, body };
}

function param(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const m = header.match(new RegExp(`${name}\\*?=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i"));
  return m ? (m[1] ?? m[2]) : undefined;
}

function decodeBytes(bytes: Uint8Array, charset = "utf-8"): string {
  try {
    return new TextDecoder(charset.toLowerCase().replace(/^us-ascii$/, "utf-8"), { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/=_-]/g, "").replace(/-/g, "+").replace(/_/g, "/");
  try {
    const bin = atob(clean);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

function qpToBytes(s: string, header = false): Uint8Array {
  const src = header ? s.replace(/_/g, " ") : s.replace(/=\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      out.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = src.charCodeAt(i);
      if (code < 128) out.push(code);
      else out.push(...new TextEncoder().encode(c));
    }
  }
  return Uint8Array.from(out);
}

/** Decode RFC 2047 encoded words: =?utf-8?Q?Hej_med_dig?= / =?UTF-8?B?...?= */
export function decodeHeader(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return v
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs: string, enc: string, data: string) =>
      decodeBytes(enc.toUpperCase() === "B" ? base64ToBytes(data) : qpToBytes(data, true), cs))
    .trim();
}

function decodeBody(p: Part): string {
  const enc = (p.headers["content-transfer-encoding"] ?? "").toLowerCase().trim();
  const charset = param(p.headers["content-type"], "charset") ?? "utf-8";
  if (enc === "base64") return decodeBytes(base64ToBytes(p.body), charset);
  if (enc === "quoted-printable") return decodeBytes(qpToBytes(p.body), charset);
  return p.body;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

type Acc = { plain: string[]; html: string[]; attachments: string[]; parts: AttachmentPart[] | null };

function partBytes(p: Part): Uint8Array {
  const enc = (p.headers["content-transfer-encoding"] ?? "").toLowerCase().trim();
  if (enc === "base64") return base64ToBytes(p.body);
  if (enc === "quoted-printable") return qpToBytes(p.body);
  return new TextEncoder().encode(p.body);
}

function walk(p: Part, acc: Acc, depth = 0) {
  const ct = (p.headers["content-type"] ?? "text/plain").toLowerCase();
  const disp = (p.headers["content-disposition"] ?? "").toLowerCase();
  const filename = decodeHeader(param(p.headers["content-disposition"], "filename") ?? param(p.headers["content-type"], "name"));
  if (ct.startsWith("multipart/") && depth < 8) {
    const boundary = param(p.headers["content-type"], "boundary");
    if (!boundary) return;
    const pieces = p.body.split(new RegExp(`^--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?\\s*$`, "m"));
    for (const piece of pieces.slice(1)) {
      const trimmed = piece.replace(/^\n/, "");
      if (!trimmed.trim()) continue;
      walk(splitHeadersBody(trimmed), acc, depth + 1);
    }
    return;
  }
  if (disp.startsWith("attachment") || (filename && !ct.startsWith("text/"))) {
    if (filename) {
      acc.attachments.push(filename);
      if (acc.parts) acc.parts.push({ filename, mime: ct.split(";")[0].trim(), bytes: partBytes(p) });
    }
    return;
  }
  if (ct.startsWith("text/plain")) acc.plain.push(decodeBody(p));
  else if (ct.startsWith("text/html")) acc.html.push(htmlToText(decodeBody(p)));
  else if (ct.startsWith("message/rfc822")) walk(splitHeadersBody(p.body.replace(/\r\n/g, "\n")), acc, depth + 1);
}

/** Message ids in a header ("<a@x> <b@y>" → ["a@x", "b@y"]); bare ids without brackets are accepted too. */
export function messageIds(v: string | undefined): string[] {
  if (!v) return [];
  const bracketed = [...v.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]);
  if (bracketed.length) return bracketed;
  return v.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s.includes("@"));
}

export function parseEmail(raw: string, opts: { withAttachments?: boolean } = {}): ParsedEmail {
  const top = splitHeadersBody(raw);
  const acc: Acc = { plain: [], html: [], attachments: [], parts: opts.withAttachments ? [] : null };
  walk(top, acc);
  const body = (acc.plain.length ? acc.plain : acc.html).join("\n\n").replace(/\r\n/g, "\n").trim();
  const dateHeader = top.headers["date"];
  const date = dateHeader ? new Date(dateHeader) : undefined;
  return {
    subject: decodeHeader(top.headers["subject"]),
    from: decodeHeader(top.headers["from"]),
    to: decodeHeader(top.headers["to"]),
    cc: decodeHeader(top.headers["cc"]),
    date: date && !Number.isNaN(date.getTime()) ? date : undefined,
    body,
    attachments: acc.attachments,
    messageId: messageIds(top.headers["message-id"])[0],
    inReplyTo: messageIds(top.headers["in-reply-to"])[0],
    references: messageIds(top.headers["references"]),
    attachmentParts: acc.parts ?? [],
  };
}

/** The text we index for an email: a short header block, then the body. */
export function emailToText(e: ParsedEmail): string {
  const head = [
    e.subject && `Subject: ${e.subject}`,
    e.from && `From: ${e.from}`,
    e.to && `To: ${e.to}`,
    e.cc && `Cc: ${e.cc}`,
    e.date && `Date: ${e.date.toISOString()}`,
    e.attachments.length ? `Attachments: ${e.attachments.join(", ")}` : undefined,
  ].filter(Boolean).join("\n");
  return head ? `${head}\n\n${e.body}` : e.body;
}
