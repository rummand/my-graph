import { describe, expect, it } from "vitest";
import { docKindOf, needsAnything, rebuildNeeds, type RebuildSource } from "./classify";

describe("docKindOf", () => {
  it("names what a file is", () => {
    expect(docKindOf({ mime: "message/rfc822" })).toBe("mail");
    expect(docKindOf({ mime: "application/mbox" })).toBe("mailbox");
    expect(docKindOf({ mime: "application/pdf", meta: { warnings: ["This PDF has little or no text layer (it may be a scan)."] } })).toBe("scan");
    expect(docKindOf({ mime: "application/pdf" })).toBe("letter");
    expect(docKindOf({ mime: "image/jpeg", meta: { ocr: "done" }, ocrChars: 400 })).toBe("scan");
    expect(docKindOf({ mime: "image/jpeg", meta: { ocr: "done" }, ocrChars: 20 })).toBe("photo");
    expect(docKindOf({ mime: "audio/mpeg" })).toBe("recording");
  });
});

describe("rebuildNeeds (idempotent rebuild)", () => {
  const fresh: RebuildSource = { mime: "message/rfc822", kind: "email", status: "ready", documentDate: null, threadKey: null, hasText: true, meta: {} };
  it("asks for what is missing", () => {
    expect(rebuildNeeds(fresh, true)).toEqual({ date: true, thread: true, kind: true, proposals: true });
    expect(rebuildNeeds(fresh, false).proposals).toBe(false);
  });
  it("skips what is already known, so a second pass does nothing", () => {
    const after: RebuildSource = { ...fresh, documentDate: new Date(), threadKey: "mid:a@x", meta: { docKind: "mail", documentDateChecked: true, changeSetId: "cs1", proposedAt: "x" } };
    expect(needsAnything(rebuildNeeds(after, true))).toBe(false);
    // Looked for a date and found none: not looked for again.
    expect(rebuildNeeds({ ...fresh, meta: { documentDateChecked: true } }, true).date).toBe(false);
    // Proposed nothing (nothing new) still counts as done.
    expect(rebuildNeeds({ ...fresh, meta: { proposedAt: "x" } }, true).proposals).toBe(false);
  });
  it("leaves files the old pipeline already wrote into the graph alone, and never reads a mail import as a document", () => {
    expect(rebuildNeeds({ ...fresh, meta: { extraction: "done", extracted: { entities: 3 } } }, true).proposals).toBe(false);
    const mbox = rebuildNeeds({ ...fresh, mime: "application/mbox", kind: "upload" }, true);
    expect(mbox.date || mbox.proposals || mbox.thread).toBe(false);
  });
});
