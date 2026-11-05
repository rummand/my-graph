import { describe, expect, it } from "vitest";
import type { ImportContext, ImportKnown } from "../types";
import { fromLocal, localParts } from "./common";
import { imessageImporter } from "./imessage";
import { fixMojibake, messengerImporter } from "./messenger";
import { chatNameFromFile, looksLikeWhatsApp, parseWhatsApp, whatsappImporter } from "./whatsapp";
import type { ChangeInput } from "@/lib/changes";

const enc = (s: string) => new TextEncoder().encode(s);
const buf = (s: string) => Buffer.from(s, "utf-8");

function ctx(known: ImportKnown[] = [], locale: "en" | "da" = "en"): ImportContext {
  let n = 0;
  return {
    sourceId: "src-1", graphKind: "family", visibility: "private", known, existingEdges: new Set(), now: new Date("2024-06-01T00:00:00Z"),
    mint: () => `id-${++n}`, locale,
  };
}
const person = (id: string, label: string, props: Record<string, unknown> = {}, aliases: string[] = []): ImportKnown =>
  ({ id, type: "person", kind: null, label, aliases, startAt: null, props });
const adds = (cs: ChangeInput[]) => cs.filter((c): c is Extract<ChangeInput, { op: "addNode" }> => c.op === "addNode");

/* ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────── */

const ANDROID_EN = [
  "12/03/2024, 14:05 - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them. Tap to learn more.",
  "12/03/2024, 14:05 - Mette Hansen: Hi! Are we still on for Saturday?",
  "12/03/2024, 14:06 - Rasmus: Yes. Ida has football at 10 in Valby",
  "so we can come after lunch",
  "12/03/2024, 14:07 - Mette Hansen: <Media omitted>",
  "13/03/2024, 09:15 - Mette Hansen: IMG-20240313-WA0004.jpg (file attached)",
  "13/03/2024, 09:15 - Mette Hansen: The invitation 🎂",
  "13/03/2024, 21:40 - Rasmus: You deleted this message",
].join("\n");

const IOS_DA = [
  "‎[12.03.24 14.05.33] Mormor: ‎Beskeder og opkald er end-to-end-krypterede. Ingen uden for denne chat kan læse eller lytte til dem.",
  "[12.03.24 14.05.33] Mormor: Hej skat, kommer I til påske?",
  "[12.03.24 14.07.02] Søren: Ja! Vi kommer torsdag d. 28. marts",
  "og bliver til mandag",
  "‎[12.03.24 14.08.10] Mormor: ‎billede udeladt",
  "‎[13.03.24 08.01.44] Søren: ‎<vedhæftet: 00000012-PHOTO-2024-03-13-08-01-44.jpg>",
].join("\n");

const IOS_US = [
  "[3/12/24, 2:05:33 PM] Mom: Did you book the dentist for Ida?",
  "[3/12/24, 2:06:01 PM] Rasmus: Yes, April 4 at 8 AM",
  "[3/14/24, 9:00:00 AM] Mom: ‎image omitted",
].join("\n");

const ANDROID_GROUP_DA = [
  "05.04.2024 18.30 - Mette Hansen oprettede gruppen \"Fodbold U10\"",
  "05.04.2024 18.30 - Mette Hansen tilføjede dig",
  "05.04.2024 18.31 - Mette Hansen: Kampen lørdag er flyttet til kl. 11",
  "05.04.2024 18.35 - +45 22 33 44 55: Tak for besked",
  "05.04.2024 18.36 - Jonas Berg: Vi kører fra skolen 10.15",
  "05.04.2024 18.37 - Rasmus: Super",
].join("\n");

/* ── WhatsApp ──────────────────────────────────────────────────────────────────────────────────────────────── */

describe("whatsapp", () => {
  it("reads Copenhagen wall-clock time, with summer time", () => {
    expect(fromLocal({ y: 2024, mo: 7, d: 1, h: 12, mi: 0, s: 0 }).toISOString()).toBe("2024-07-01T10:00:00.000Z");
    expect(fromLocal({ y: 2024, mo: 1, d: 15, h: 12, mi: 0, s: 0 }).toISOString()).toBe("2024-01-15T11:00:00.000Z");
    expect(localParts(new Date("2024-03-31T01:30:00Z")).h).toBe(3);
  });

  it("names the chat from the file name, English and Danish", () => {
    expect(chatNameFromFile("WhatsApp Chat with Mette Hansen.txt")).toBe("Mette Hansen");
    expect(chatNameFromFile("WhatsApp-chat med Mormor.zip")).toBe("Mormor");
    expect(chatNameFromFile("WhatsApp Chat - Mormor.zip")).toBe("Mormor");
    expect(chatNameFromFile("notes.txt")).toBeNull();
  });

  it("detects exports by name and lines, nothing else", () => {
    expect(whatsappImporter.detect({ filename: "WhatsApp Chat with Mette Hansen.txt", head: enc(ANDROID_EN) })).toBe(true);
    expect(whatsappImporter.detect({ filename: "_chat.txt", head: enc(IOS_DA) })).toBe(true);
    expect(whatsappImporter.detect({ filename: "WhatsApp-chat med Fodbold U10.txt", head: enc(ANDROID_GROUP_DA) })).toBe(true);
    expect(whatsappImporter.detect({ filename: "chat.txt", head: enc(ANDROID_EN) })).toBe(false);
    expect(whatsappImporter.detect({ filename: "WhatsApp Chat with Mor.txt", head: enc("Indkøbsliste\nmælk\nbrød") })).toBe(false);
    expect(looksLikeWhatsApp("12/03/2024 was a good day\nreally")).toBe(false);
  });

  it("detects the zips (iOS and Android, with media) but not other zips", () => {
    expect(whatsappImporter.detectArchive!({ filename: "WhatsApp Chat - Mormor.zip", names: ["_chat.txt", "00000012-PHOTO-2024-03-13-08-01-44.jpg"] })).toBe(true);
    expect(whatsappImporter.detectArchive!({ filename: "x.zip", names: ["WhatsApp Chat with Mette Hansen.txt", "IMG-20240313-WA0004.jpg", "PTT-20240313-WA0005.opus"] })).toBe(true);
    expect(whatsappImporter.detectArchive!({ filename: "mails.zip", names: ["a.eml", "b.eml"] })).toBe(false);
    expect(whatsappImporter.detectArchive!({ filename: "backup.zip", names: ["chats/_chat.txt", "chats/other.txt"] })).toBe(false);
    expect(whatsappImporter.detectArchive!({ filename: "Mormor.zip", names: ["WhatsApp Chat - Mormor/_chat.txt", "WhatsApp Chat - Mormor/00000012-PHOTO.jpg"] })).toBe(true);
    expect(whatsappImporter.detectArchive!({ filename: "backup.zip", names: ["a/_chat.txt", "b/x.jpg"] })).toBe(false);
  });

  it("parses Android (day-first, 24h): multi-line, system lines, media, me", () => {
    const { thread } = parseWhatsApp(ANDROID_EN, "WhatsApp Chat with Mette Hansen.txt");
    expect(thread.title).toBe("Mette Hansen");
    expect(thread.me).toBe("Rasmus");
    expect(thread.group).toBe(false);
    const msgs = thread.messages;
    expect(msgs[0].author).toBeNull();
    expect(msgs[2].text).toBe("Yes. Ida has football at 10 in Valby\nso we can come after lunch");
    expect(msgs[3].media).toEqual([""]);
    expect(msgs[4].media).toEqual(["IMG-20240313-WA0004.jpg"]);
    expect(msgs[1].at.toISOString()).toBe("2024-03-12T13:05:00.000Z");
  });

  it("parses Danish iOS (dots, direction marks, vedhæftet) and finds the chat and me", () => {
    const { thread } = parseWhatsApp(IOS_DA, "_chat.txt");
    expect(thread.title).toBe("Mormor");
    expect(thread.me).toBe("Søren");
    expect(thread.messages[0].author).toBeNull();
    expect(thread.messages[2].text).toContain("og bliver til mandag");
    expect(thread.messages[3].media).toEqual([""]);
    expect(thread.messages[4].media).toEqual(["00000012-PHOTO-2024-03-13-08-01-44.jpg"]);
    expect(thread.messages[1].at.toISOString()).toBe("2024-03-12T13:05:33.000Z");
  });

  it("parses US iOS (month-first, AM/PM with a narrow space)", () => {
    const { thread } = parseWhatsApp(IOS_US, "WhatsApp Chat - Mom.zip");
    expect(thread.messages.map((m) => m.at.toISOString())).toEqual(["2024-03-12T13:05:33.000Z", "2024-03-12T13:06:01.000Z", "2024-03-14T08:00:00.000Z"]);
    expect(thread.me).toBe("Rasmus");
  });

  it("plans: day segments with locators, people proposed or matched, me left out, sensitive and extracted", async () => {
    const known = [person("p-mette", "Mette Hansen", { phone: "+45 11 22 33 44" })];
    const plan = await whatsappImporter.read({ filename: "WhatsApp Chat with Mette Hansen.txt", bytes: buf(ANDROID_EN) }, ctx(known));
    expect(whatsappImporter.sensitive).toBe(true);
    expect(plan.extract).toBe(true);
    expect(plan.segments).toHaveLength(2);
    expect(plan.segments[0].at?.region).toBe("Mette Hansen · 2024-03-12");
    expect(plan.segments[0].text).toContain("14:06 Rasmus: Yes. Ida has football");
    expect(plan.segments[1].text).toContain("[attached: IMG-20240313-WA0004.jpg]");
    expect(plan.changes).toHaveLength(0); // Mette is known; Rasmus is me
    expect(plan.counts["people already known"]).toBe(1);
    expect(plan.occurredAt?.toISOString()).toBe("2024-03-13T20:40:00.000Z");
    expect(plan.title).toBe("WhatsApp chat with Mette Hansen (7 messages)");
  });

  it("group chat: proposes new people, matches a number, warns that me is unknown", async () => {
    const known = [person("p-anna", "Anna Berg", { phone: "22334455" })];
    const plan = await whatsappImporter.read({ filename: "WhatsApp-chat med Fodbold U10.txt", bytes: buf(ANDROID_GROUP_DA) }, ctx(known, "da"));
    const added = adds(plan.changes);
    expect(added.map((a) => a.label).sort()).toEqual(["Jonas Berg", "Mette Hansen", "Rasmus"]);
    expect(added[0].receipt?.sourceId).toBe("src-1");
    expect(added.find((a) => a.label === "Jonas Berg")!.receipt?.quote).toBe("18:36 Jonas Berg: Vi kører fra skolen 10.15");
    expect(plan.counts["people already known"]).toBe(1);
    expect(plan.warnings?.some((w) => w.includes("which name in a group chat is yours"))).toBe(true);
    expect(plan.title).toBe("WhatsApp-chat Fodbold U10 (6 beskeder)");
  });

  it("reads the chat out of a zip", async () => {
    const plan = await whatsappImporter.read({
      filename: "WhatsApp Chat - Mormor.zip", bytes: Buffer.alloc(0), entries: [{ name: "_chat.txt", bytes: enc(IOS_DA) }],
    }, ctx());
    expect(plan.segments.length).toBe(2);
    expect(adds(plan.changes).map((a) => a.label)).toEqual(["Mormor"]);
    expect(plan.warnings?.some((w) => w.includes("not saved as their own items"))).toBe(true);
  });
});

/* ── Messenger / Instagram ─────────────────────────────────────────────────────────────────────────────────── */

/** Meta's encoding: UTF-8 bytes written as Latin-1 characters. */
const mojibake = (s: string) => String.fromCharCode(...new TextEncoder().encode(s));

const thread = (title: string, participants: string[], messages: { from: string; text: string; ms: number; photo?: string }[]) => ({
  participants: participants.map((name) => ({ name: mojibake(name) })),
  messages: messages.map((m) => ({
    sender_name: mojibake(m.from), timestamp_ms: m.ms, content: mojibake(m.text), ...(m.photo ? { photos: [{ uri: m.photo, creation_timestamp: 1 }] } : {}), is_geoblocked_for_viewer: false,
  })).reverse(),
  title: mojibake(title), is_still_participant: true, thread_path: `inbox/${title.toLowerCase().replace(/\W/g, "")}_123`, magic_words: [],
});

describe("messenger", () => {
  it("undoes Meta's mojibake and leaves good text alone", () => {
    expect(fixMojibake(mojibake("Søren Ærø – på båd 🚤"))).toBe("Søren Ærø – på båd 🚤");
    expect(fixMojibake("Søren")).toBe("Søren");
    expect(fixMojibake("plain")).toBe("plain");
  });

  const SOREN = thread("Søren Ødegaard", ["Søren Ødegaard", "Rasmus Holm"], [
    { from: "Søren Ødegaard", text: "Skal vi ses i Århus på fredag?", ms: Date.UTC(2023, 9, 6, 16, 0) },
    { from: "Rasmus Holm", text: "Ja, jeg tager toget kl. 17", ms: Date.UTC(2023, 9, 6, 16, 5), photo: "messages/inbox/soren_123/photos/4432.jpg" },
  ]);
  const GROUP = thread("Familien ❤️", ["Rasmus Holm", "Lise Holm", "Karen Holm"], [
    { from: "Lise Holm", text: "Husk mormors fødselsdag d. 14.", ms: Date.UTC(2023, 10, 1, 8, 0) },
    { from: "Karen Holm", text: "Jeg tager kage med", ms: Date.UTC(2023, 10, 1, 9, 0) },
  ]);

  it("detects a single message_1.json and Meta's zip layout", () => {
    expect(messengerImporter.detect({ filename: "message_1.json", head: enc(JSON.stringify(SOREN)) })).toBe(true);
    expect(messengerImporter.detect({ filename: "data.json", head: enc(JSON.stringify(SOREN)) })).toBe(false);
    expect(messengerImporter.detect({ filename: "message_1.json", head: enc('{"foo":1}') })).toBe(false);
    expect(messengerImporter.detectArchive!({ filename: "facebook-rasmus.zip", names: ["your_facebook_activity/messages/inbox/soren_123/message_1.json"] })).toBe(true);
    expect(messengerImporter.detectArchive!({ filename: "facebook-rasmus.zip", names: ["messages/inbox/soren_123/message_1.html"] })).toBe(false);
  });

  it("a single thread: fixes names, finds me from the title, proposes the other", async () => {
    const plan = await messengerImporter.read({ filename: "message_1.json", bytes: buf(JSON.stringify(SOREN)) }, ctx());
    expect(adds(plan.changes).map((a) => a.label)).toEqual(["Søren Ødegaard"]);
    expect(plan.segments[0].text).toContain("Skal vi ses i Århus på fredag?");
    expect(plan.segments[0].text).toContain("[attached: 4432.jpg]");
    expect(plan.occurredAt?.toISOString()).toBe("2023-10-06T16:05:00.000Z");
    expect(plan.extract).toBe(true);
  });

  it("a zip: the owner is the one in every thread (or the profile), never proposed", async () => {
    const plan = await messengerImporter.read({
      filename: "facebook.zip", bytes: Buffer.alloc(0),
      entries: [
        { name: "your_facebook_activity/messages/inbox/soren_123/message_1.json", bytes: enc(JSON.stringify(SOREN)) },
        { name: "your_facebook_activity/messages/inbox/familien_456/message_1.json", bytes: enc(JSON.stringify(GROUP)) },
      ],
    }, ctx([person("p-lise", "Lise Holm")]));
    expect(adds(plan.changes).map((a) => a.label).sort()).toEqual(["Karen Holm", "Søren Ødegaard"]);
    expect(plan.counts.chats).toBe(2);
    expect(plan.counts["people already known"]).toBe(1);
    expect(plan.warnings ?? []).not.toContain(expect.stringContaining("which name"));
  });

  it("reads the end-to-end-encrypted Messenger shape", async () => {
    const e2ee = { participants: ["Rasmus Holm", "Maja Lund"], threadName: "Maja Lund", messages: [
      { isUnsent: false, media: [], reactions: [], senderName: "Maja Lund", text: "Tak for i går!", timestamp: Date.UTC(2024, 4, 2, 7), type: "text" },
    ] };
    const plan = await messengerImporter.read({ filename: "message_1.json", bytes: buf(JSON.stringify(e2ee)) }, ctx());
    expect(adds(plan.changes).map((a) => a.label)).toEqual(["Maja Lund"]);
  });
});

/* ── iMessage ──────────────────────────────────────────────────────────────────────────────────────────────── */

describe("imessage", () => {
  const payload = {
    chats: [{
      id: "chat-1", participants: [{ handle: "+4522334455", name: "Anna Berg" }, { handle: "jonas@example.dk" }, { handle: "+4599887766", name: "Peter Lund" }],
      messages: [
        { id: "m1", at: "2024-05-01T15:00:00Z", from: "+4522334455", text: "Kan Ida blive hentet kl. 15?", attachments: [] },
        { id: "m2", at: "2024-05-01T15:02:00Z", from: "me", text: "Ja, jeg henter", attachments: [] },
        { id: "m3", at: "2024-05-01T15:03:00Z", from: "jonas@example.dk", text: "👍", attachments: [{ filename: "IMG_2231.HEIC" }] },
        { id: "m4", at: "2024-05-02T08:00:00Z", from: "+4599887766", text: "Godmorgen", attachments: [] },
      ],
    }],
  };

  it("validates against the shared schema, is never an upload", () => {
    expect(imessageImporter.json!.safeParse(payload).success).toBe(true);
    expect(imessageImporter.detect({ filename: "x.json", head: enc(JSON.stringify(payload)) })).toBe(false);
  });

  it("matches by handle, adds a missing email only into an empty field, proposes named strangers", async () => {
    const known = [person("p-anna", "Anna", { phone: "22 33 44 55" }), person("p-jonas", "Jonas Berg", { email: "jonas@example.dk" })];
    const plan = await imessageImporter.read({ filename: "iMessage", bytes: buf(JSON.stringify(imessageImporter.json!.parse(payload))) }, ctx(known));
    expect(adds(plan.changes).map((a) => a.label)).toEqual(["Peter Lund"]);
    expect(adds(plan.changes)[0].props).toEqual({ phone: "+4599887766" });
    expect(plan.counts["people already known"]).toBe(2);
    expect(plan.segments).toHaveLength(2);
    expect(plan.segments[0].text).toContain("Me: Ja, jeg henter");
    expect(plan.segments[0].text).toContain("[attached: IMG_2231.HEIC]");
    expect(plan.extract).toBe(true);
  });

  it("refuses a batch in the wrong shape", async () => {
    const plan = await imessageImporter.read({ filename: "x", bytes: buf("{\"chats\": 3}") }, ctx());
    expect(plan.segments).toHaveLength(0);
    expect(plan.warnings?.[0]).toMatch(/shape/);
  });
});
