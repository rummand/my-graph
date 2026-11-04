import { describe, expect, it } from "vitest";
import { detectFileType, extensionOf, kindFromMime, looksLikeText, mimeCategory } from "./mime";

const bytes = (...xs: (number | string)[]) =>
  Uint8Array.from(xs.flatMap((x) => (typeof x === "string" ? Array.from(x, (c) => c.charCodeAt(0)) : [x])));
const text = (s: string) => new TextEncoder().encode(s);
const pad = (b: Uint8Array, n = 64) => { const o = new Uint8Array(Math.max(n, b.length)); o.set(b); return o; };

describe("detectFileType", () => {
  it("detects binary formats from magic bytes regardless of name", () => {
    expect(detectFileType("x.bin", "", pad(bytes("%PDF-1.7")))).toMatchObject({ ok: true, kind: "pdf", mime: "application/pdf" });
    expect(detectFileType("photo", "", pad(bytes(0xff, 0xd8, 0xff, 0xe0)))).toMatchObject({ ok: true, kind: "image", mime: "image/jpeg" });
    expect(detectFileType("a.png", "image/png", pad(bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a)))).toMatchObject({ ok: true, mime: "image/png" });
    expect(detectFileType("a.webp", "", pad(bytes("RIFF", 0, 0, 0, 0, "WEBP")))).toMatchObject({ ok: true, mime: "image/webp" });
    expect(detectFileType("IMG_1.HEIC", "", pad(bytes(0, 0, 0, 24, "ftypheic")))).toMatchObject({ ok: true, kind: "image", mime: "image/heic" });
    expect(detectFileType("memo.m4a", "audio/x-m4a", pad(bytes(0, 0, 0, 32, "ftypM4A ")))).toMatchObject({ ok: true, kind: "audio", mime: "audio/mp4" });
    expect(detectFileType("a.wav", "", pad(bytes("RIFF", 0, 0, 0, 0, "WAVE")))).toMatchObject({ ok: true, mime: "audio/wav" });
    expect(detectFileType("a.ogg", "", pad(bytes("OggS")))).toMatchObject({ ok: true, mime: "audio/ogg" });
    expect(detectFileType("a.mp3", "", pad(bytes("ID3", 4, 0)))).toMatchObject({ ok: true, mime: "audio/mpeg" });
    expect(detectFileType("a.mp3", "", pad(bytes(0xff, 0xfb, 0x90)))).toMatchObject({ ok: true, mime: "audio/mpeg" });
    expect(detectFileType("rec.webm", "audio/webm", pad(bytes(0x1a, 0x45, 0xdf, 0xa3)))).toMatchObject({ ok: true, mime: "audio/webm" });
  });

  it("tells docx apart from other zip files", () => {
    const zip = pad(bytes("PK", 3, 4));
    expect(detectFileType("Letter.docx", "", zip)).toMatchObject({ ok: true, kind: "docx" });
    expect(detectFileType("Budget.xlsx", "", zip)).toMatchObject({ ok: true, kind: "spreadsheet", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    expect(detectFileType("Møde.pptx", "", zip)).toMatchObject({ ok: true, kind: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
    expect(detectFileType("Ark.ods", "", zip)).toMatchObject({ ok: true, kind: "spreadsheet", mime: "application/vnd.oasis.opendocument.spreadsheet" });
    // No useful name: the part names near the start of the zip tell.
    expect(detectFileType("upload", "", pad(bytes("PK", 3, 4, "....[Content_Types].xml....ppt/slides/slide1.xml")))).toMatchObject({ ok: true, kind: "pptx" });
    // A .zip is a mail import (its .eml files are read); a zip under another name is still refused.
    expect(detectFileType("mail.zip", "", zip)).toMatchObject({ ok: true, kind: "archive", mime: "application/zip" });
    expect(detectFileType("stuff.bin", "", zip)).toMatchObject({ ok: false });
  });

  it("accepts a mailbox (.mbox) as a mail import", () => {
    const mbox = new TextEncoder().encode("From a@x.dk Tue Nov  3 08:15:00 2026\nSubject: hi\n\nbody\n");
    expect(detectFileType("Inbox.mbox", "", mbox)).toMatchObject({ ok: true, kind: "mailbox", mime: "application/mbox" });
  });

  it("accepts text formats by extension when the bytes are text", () => {
    expect(detectFileType("notes.md", "", text("# Hej\nÆble og øl"))).toMatchObject({ ok: true, kind: "text", mime: "text/markdown" });
    expect(detectFileType("data.csv", "text/csv", text("a,b\n1,2"))).toMatchObject({ ok: true, kind: "spreadsheet", mime: "text/csv" });
    expect(detectFileType("readme.txt", "", text("hello"))).toMatchObject({ ok: true, mime: "text/plain" });
    expect(detectFileType("mail.eml", "", text("From: a@b.dk\nSubject: Hi\n\nBody"))).toMatchObject({ ok: true, kind: "email", mime: "message/rfc822" });
  });

  it("rejects disguised, unsupported and empty files with a clear reason", () => {
    const exe = detectFileType("invoice.pdf", "application/pdf", pad(bytes("MZ", 0x90, 0)));
    expect(exe.ok).toBe(false);
    if (!exe.ok) expect(exe.reason).toMatch(/contents don't match/);
    const txtBinary = detectFileType("a.txt", "", bytes(0x00, 0x01, 0x02, 0x03));
    expect(txtBinary.ok).toBe(false);
    const html = detectFileType("page.html", "text/html", text("<html></html>"));
    expect(html.ok).toBe(false);
    if (!html.ok) expect(html.reason).toMatch(/Accepted:/);
    expect(detectFileType("empty.txt", "", new Uint8Array())).toMatchObject({ ok: false });
    expect(detectFileType("clip.mp4", "video/mp4", pad(bytes(0, 0, 0, 24, "ftypisom")))).toMatchObject({ ok: false });
    expect(detectFileType("old.doc", "", pad(bytes(0xd0, 0xcf, 0x11, 0xe0)))).toMatchObject({ ok: false });
    expect(detectFileType("Regnskab.xls", "", pad(bytes(0xd0, 0xcf, 0x11, 0xe0)))).toMatchObject({ ok: true, kind: "spreadsheet", mime: "application/vnd.ms-excel" });
    const ppt = detectFileType("Gammel.ppt", "", pad(bytes(0xd0, 0xcf, 0x11, 0xe0)));
    expect(ppt.ok).toBe(false);
    if (!ppt.ok) expect(ppt.reason).toMatch(/old PowerPoint file \(\.ppt\).*save it as \.pptx/);
  });
});

describe("helpers", () => {
  it("extensionOf", () => {
    expect(extensionOf("a/b/Report.Final.PDF")).toBe("pdf");
    expect(extensionOf(".bashrc")).toBe("");
    expect(extensionOf("noext")).toBe("");
  });
  it("looksLikeText tolerates a cut multi-byte character at the end", () => {
    const b = text("abc ø");
    expect(looksLikeText(b.slice(0, b.length - 1))).toBe(true);
    expect(looksLikeText(bytes(0xff, 0xfe, 0xfd, 0xfc, 0x41, 0x41, 0x41, 0x41))).toBe(false);
  });
  it("mimeCategory and kindFromMime round-trip", () => {
    expect(mimeCategory("application/pdf")).toBe("pdf");
    expect(mimeCategory("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("document");
    expect(mimeCategory("audio/mp4")).toBe("audio");
    expect(mimeCategory(null)).toBe("other");
    expect(kindFromMime("message/rfc822")).toBe("email");
    expect(kindFromMime("text/csv")).toBe("spreadsheet");
    expect(kindFromMime("application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe("pptx");
    expect(kindFromMime("application/vnd.ms-excel")).toBe("spreadsheet");
    expect(mimeCategory("application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe("slides");
    expect(mimeCategory("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("spreadsheet");
    expect(mimeCategory("text/csv")).toBe("spreadsheet");
    expect(kindFromMime("application/zip")).toBe("archive");
    expect(kindFromMime("application/mbox")).toBe("mailbox");
    expect(kindFromMime("application/octet-stream")).toBeNull();
  });
});
