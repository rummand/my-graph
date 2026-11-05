import { describe, expect, it } from "vitest";
import { DocError, docToText, excerpt, extractMentions, extractPageLinks, safeHref, sanitizeDoc, type DocNode } from "./doc";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const PG = "33333333-3333-4333-8333-333333333333";

const doc: DocNode = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "School start" }] },
    { type: "paragraph", content: [
      { type: "mention", attrs: { id: P1, label: "Anna", nodeType: "person" } },
      { type: "text", text: " starts at " },
      { type: "mention", attrs: { id: P2, label: "Skovbo Skole", nodeType: "place" } },
      { type: "text", text: ". See " },
      { type: "pageLink", attrs: { id: PG, label: "Packing list", slug: "packing-list" } },
      { type: "text", text: ".", marks: [{ type: "bold" }] },
    ] },
    { type: "taskList", content: [
      { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Buy bag" }] }] },
      { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "Label clothes" }] }] },
    ] },
    { type: "bulletList", content: [
      { type: "listItem", content: [{ type: "paragraph", content: [
        { type: "text", text: "Ask " }, { type: "mention", attrs: { id: P1, label: "Anna", nodeType: "person" } },
      ] }] },
    ] },
    { type: "paragraph", content: [{ type: "text", text: "line one" }, { type: "hardBreak" }, { type: "text", text: "line two" }] },
  ],
};

describe("docToText", () => {
  it("flattens blocks, mentions and lists into readable text", () => {
    expect(docToText(doc)).toBe(
      "School start\n\nAnna starts at Skovbo Skole. See Packing list.\n\n[x] Buy bag\n[ ] Label clothes\n\n- Ask Anna\n\nline one\nline two",
    );
  });
  it("is empty for an empty document", () => {
    expect(docToText({ type: "doc", content: [{ type: "paragraph" }] })).toBe("");
  });
});

describe("extractMentions / extractPageLinks", () => {
  it("finds each mentioned node once, in order", () => {
    expect(extractMentions(doc)).toEqual([
      { id: P1, label: "Anna", nodeType: "person" },
      { id: P2, label: "Skovbo Skole", nodeType: "place" },
    ]);
  });
  it("finds page links", () => {
    expect(extractPageLinks(doc)).toEqual([{ id: PG, label: "Packing list", slug: "packing-list" }]);
  });
});

describe("sanitizeDoc", () => {
  it("keeps a valid document intact", () => {
    expect(sanitizeDoc(doc)).toEqual(doc);
  });
  it("drops unknown nodes, unknown marks and unsafe links", () => {
    const out = sanitizeDoc({ type: "doc", content: [
      { type: "script", content: [{ type: "text", text: "x" }] },
      { type: "paragraph", content: [
        { type: "text", text: "a", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }, { type: "evil" }] },
        { type: "text", text: "b", marks: [{ type: "link", attrs: { href: "https://aula.dk", onclick: "x" } }] },
      ] },
    ] });
    expect(out).toEqual({ type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "a" },
      { type: "text", text: "b", marks: [{ type: "link", attrs: { href: "https://aula.dk/" } }] },
    ] }] });
  });
  it("rejects non-documents and mentions without a real id", () => {
    expect(() => sanitizeDoc({ type: "paragraph" })).toThrow(DocError);
    expect(() => sanitizeDoc({ type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: "x" } }] }] })).toThrow(DocError);
  });
  it("gives an empty document a paragraph", () => {
    expect(sanitizeDoc({ type: "doc" })).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
  });
  it("rejects oversized documents", () => {
    const big = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(1_100_000) }] }] };
    expect(() => sanitizeDoc(big)).toThrow(/too long/);
  });
});

describe("safeHref", () => {
  it("allows web, mail, phone and in-app links", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com/");
    expect(safeHref("mailto:a@b.dk")).toBe("mailto:a@b.dk");
    expect(safeHref("/wiki/x")).toBe("/wiki/x");
  });
  it("blocks script, data and protocol-relative links", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,hi")).toBeNull();
    expect(safeHref("//evil.com")).toBeNull();
    expect(safeHref(42)).toBeNull();
  });
});

describe("excerpt", () => {
  it("cuts on a word boundary", () => {
    expect(excerpt("alpha beta gamma delta", 12)).toBe("alpha beta…");
    expect(excerpt("short", 12)).toBe("short");
  });
});
