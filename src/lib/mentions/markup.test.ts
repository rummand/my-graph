import { describe, expect, it } from "vitest";
import { findKnownNames, findWord, fromMarkup, linkFirstOccurrences, locateSpans, mentionQueryAt, parseMentions, segments, toMarkup } from "./markup";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("mention markup", () => {
  it("parses and round-trips", () => {
    const text = `Ask @[Emma Hansen](node:${A}) about @[EAM Platform](node:${B}).`;
    expect(parseMentions(text).map((m) => [m.label, m.nodeId])).toEqual([["Emma Hansen", A], ["EAM Platform", B]]);
    const plain = fromMarkup(text);
    expect(plain.text).toBe("Ask @Emma Hansen about @EAM Platform.");
    expect(toMarkup(plain.text, plain.mentions)).toBe(text);
  });

  it("prefers the longest label and respects word ends", () => {
    expect(toMarkup("@Emma Hansen and @Emma", [{ label: "Emma", nodeId: A }, { label: "Emma Hansen", nodeId: B }]))
      .toBe(`@[Emma Hansen](node:${B}) and @[Emma](node:${A})`);
    expect(toMarkup("@Emmanuel", [{ label: "Emma", nodeId: A }])).toBe("@Emmanuel");
  });

  it("links the first plain occurrence after Send, never inside existing markup", () => {
    const t = `I work on EAM Platform with @[EAM](node:${A}); EAM Platform rocks`;
    expect(linkFirstOccurrences(t, [{ label: "EAM Platform", nodeId: B }])).toBe(`I work on @[EAM Platform](node:${B}) with @[EAM](node:${A}); EAM Platform rocks`);
  });
});

describe("span mapping", () => {
  const text = "Im working on a project for my department Architecture Enablement, the project is called EAM Platform";

  it("finds entities at word boundaries, longest first, without overlaps", () => {
    const spans = locateSpans(text, [{ ref: "p", surface: "EAM Platform" }, { ref: "d", surface: "Architecture Enablement" }, { ref: "x", surface: "Platform" }]);
    expect(spans.map((s) => [s.ref, s.text])).toEqual([["d", "Architecture Enablement"], ["p", "EAM Platform"]]);
    expect(text.slice(spans[1].start, spans[1].end)).toBe("EAM Platform");
  });

  it("falls back to any case and to alternatives", () => {
    expect(locateSpans("we met eam platform folks", [{ ref: "p", surface: "EAM Platform" }])[0]).toMatchObject({ start: 7, end: 19 });
    expect(locateSpans("ask @Emma today", [{ ref: "e", surface: "Emma H.", alternatives: ["@Emma"] }])[0].text).toBe("@Emma");
    expect(findWord("Emmanuel and Emma", "Emma")).toBe(13);
  });

  it("splits text into segments for rendering", () => {
    const segs = segments("a bc d", [{ start: 2, end: 4 }]);
    expect(segs.map((s) => [s.text, !!s.span])).toEqual([["a ", false], ["bc", true], [" d", false]]);
  });

  it("finds known names offline", () => {
    const hits = findKnownNames("Emma and Emma Hansen met", [{ id: "1", label: "Emma Hansen" }, { id: "2", label: "Bo" }]);
    expect(hits).toEqual([{ node: { id: "1", label: "Emma Hansen" }, start: 9, end: 20 }]);
  });

  it("reads the @query at the caret, not in email addresses", () => {
    expect(mentionQueryAt("hi @Arch", 8)).toEqual({ start: 3, query: "Arch" });
    expect(mentionQueryAt("mail sara@example.com", 21)).toBeNull();
    expect(mentionQueryAt("hi @", 4)).toEqual({ start: 3, query: "" });
    expect(mentionQueryAt("hi @ x", 6)).toBeNull();
  });
});
