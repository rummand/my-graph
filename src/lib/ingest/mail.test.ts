import { describe, expect, it } from "vitest";
import { parseEmail } from "./email";
import { displayName, looksLikeMbox, normalizeSubject, parseAddresses, participantsOf, resolveThreads, splitMbox, threadKeyFor } from "./mail";

const msg = (id: string, extra: string[], subject = "Forældremøde", body = "Hej") => [
  `From: Anna Hansen <anna@example.dk>`, `To: "Lærer, Bo" <bo@skole.dk>`, `Subject: ${subject}`,
  `Date: Tue, 3 Nov 2026 08:15:00 +0100`, `Message-ID: <${id}>`, ...extra, "", body,
].join("\n");

describe("splitMbox", () => {
  it("splits on From lines after a blank line and unescapes >From", () => {
    const mbox = [
      "From anna@example.dk Tue Nov  3 08:15:00 2026", msg("a@x", [], "First", "Line one\n>From the start\nFrom inside a paragraph"), "",
      "From bo@skole.dk Wed Nov  4 09:00:00 2026", msg("b@x", ["In-Reply-To: <a@x>"], "Re: First"), "",
    ].join("\n");
    const parts = splitMbox(mbox);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("From the start");
    expect(parts[0]).not.toContain(">From the start");
    expect(parts[0]).toContain("From inside a paragraph");
    expect(parseEmail(parts[1]).inReplyTo).toBe("a@x");
  });
  it("handles CRLF and an empty file", () => {
    expect(splitMbox("")).toEqual([]);
    expect(splitMbox("From - Mon Jan 1 00:00:00 2024\r\nSubject: x\r\n\r\nbody\r\n")).toHaveLength(1);
  });
  it("recognises an mbox by its first line", () => {
    expect(looksLikeMbox("\nFrom MAILER-DAEMON Fri Jul  8 12:08:34 2011\n")).toBe(true);
    expect(looksLikeMbox("Subject: hi\n")).toBe(false);
  });
});

describe("addresses", () => {
  it("reads names, quoted commas and bare addresses", () => {
    expect(parseAddresses(`Anna Hansen <Anna@Example.dk>, "Lærer, Bo" <bo@skole.dk>; c@y.dk`)).toEqual([
      { name: "Anna Hansen", email: "anna@example.dk" },
      { name: "Lærer, Bo", email: "bo@skole.dk" },
      { name: null, email: "c@y.dk" },
    ]);
  });
  it("lists participants once, sender first", () => {
    const p = participantsOf({ from: "a@x.dk", to: "b@x.dk, A@x.dk", cc: "c@x.dk" });
    expect(p.map((x) => `${x.role}:${x.email}`)).toEqual(["from:a@x.dk", "to:b@x.dk", "cc:c@x.dk"]);
  });
  it("makes a name from an address", () => {
    expect(displayName({ name: null, email: "bo.hansen@skole.dk" })).toBe("Bo Hansen");
  });
});

describe("thread keys", () => {
  it("prefers the References root, then In-Reply-To, then the message id, then the subject", () => {
    expect(threadKeyFor({ messageId: "c@x", inReplyTo: "b@x", references: ["a@x", "b@x"], subject: "Re: x" })).toBe("mid:a@x");
    expect(threadKeyFor({ messageId: "c@x", inReplyTo: "B@x", references: [], subject: "x" })).toBe("mid:b@x");
    expect(threadKeyFor({ messageId: "A@x", references: [] })).toBe("mid:a@x");
    expect(threadKeyFor({ references: [], subject: "SV: Re: Forældremøde" })).toBe("subj:forældremøde");
    expect(threadKeyFor({ references: [] })).toBeNull();
  });
  it("strips Danish and English reply prefixes", () => {
    expect(normalizeSubject("Re: SV: Fwd: VS: [Aula] Forældremøde")).toBe("forældremøde");
  });
  it("joins a chain of In-Reply-To replies into one thread, whatever the order", () => {
    const msgs = [
      { messageId: "c@x", inReplyTo: "b@x", references: [] },
      { messageId: "a@x", references: [] },
      { messageId: "b@x", inReplyTo: "a@x", references: [] },
      { messageId: "z@x", references: [] },
    ];
    const k = resolveThreads(msgs);
    expect(k.get("a@x")).toBe("mid:a@x");
    expect(k.get("b@x")).toBe("mid:a@x");
    expect(k.get("c@x")).toBe("mid:a@x");
    expect(k.get("z@x")).toBe("mid:z@x");
    // Same answer as reading each message alone when References is present.
    expect(resolveThreads([{ messageId: "d@x", inReplyTo: "c@x", references: ["a@x", "c@x"] }]).get("d@x")).toBe("mid:a@x");
  });
  it("keys a thread whose first message is missing by that missing message", () => {
    const k = resolveThreads([{ messageId: "c@x", inReplyTo: "b@x", references: [] }, { messageId: "b@x", inReplyTo: "a@x", references: [] }]);
    expect(k.get("c@x")).toBe("mid:a@x");
    expect(k.get("b@x")).toBe("mid:a@x");
  });
});

describe("parseEmail threading headers", () => {
  it("reads Message-ID, In-Reply-To, References and Cc", () => {
    const e = parseEmail(msg("m3@x", ["In-Reply-To: <m2@x>", "References: <m1@x>\n <m2@x>", "Cc: c@x.dk"]));
    expect(e.messageId).toBe("m3@x");
    expect(e.inReplyTo).toBe("m2@x");
    expect(e.references).toEqual(["m1@x", "m2@x"]);
    expect(e.cc).toBe("c@x.dk");
  });
  it("returns attachment bytes only when asked", () => {
    const raw = [
      "From: a@x.dk", "Subject: Brev", 'Content-Type: multipart/mixed; boundary="b"', "", "--b", "Content-Type: text/plain", "", "Se vedhæftet", "--b",
      'Content-Type: application/pdf; name="brev.pdf"', "Content-Transfer-Encoding: base64", 'Content-Disposition: attachment; filename="brev.pdf"', "",
      Buffer.from("%PDF-1.4 test").toString("base64"), "--b--",
    ].join("\n");
    expect(parseEmail(raw).attachmentParts).toEqual([]);
    const parts = parseEmail(raw, { withAttachments: true }).attachmentParts;
    expect(parts).toHaveLength(1);
    expect(parts[0].filename).toBe("brev.pdf");
    expect(new TextDecoder().decode(parts[0].bytes)).toBe("%PDF-1.4 test");
  });
});
