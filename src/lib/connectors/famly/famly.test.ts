import { describe, expect, it } from "vitest";
import { validateManifest } from "../manifest";
import type { HttpRequest, HttpResponse } from "@/lib/mcp-client/transport";
import { deviceIdFor, FamlyApi, FamlyError } from "./client";
import {
  childOps, childrenFrom, conversationsFrom, eventOf, famlyDate, feedItemOf, feedSource, imagesFrom, loginResult, matchChildren, messageSource,
  messagesFrom, newMessages, noteSource, notesFrom,
} from "./map";

/* Fixtures in the shapes famly-fetch and famly-downloader document. */
const me = { roles2: [{ targetId: "c-1", title: "Ida Hansen", targetType: "Famly.Daycare:Child" }, { targetId: "i-9", title: "Solsikken", targetType: "Famly.Daycare:Institution" }] };
const feed = {
  feedItems: [
    {
      feedItemId: "f-2", originatorId: "Post:abc", createdDate: "2026-11-04T13:10:00+00:00", body: "Vi har bagt boller i dag!\nTak for en god dag.",
      sender: { name: "Stuen Solsikken" }, images: [{ imageId: "img-1", prefix: "https://img.famly.co/image/xyz", key: "2026/11/04/a.jpg", width: 800, height: 600 }],
      files: [{ fileId: "file-1", url: "https://app.famly.co/files/menu.pdf", filename: "Menu uge 46.pdf" }],
    },
    { feedItemId: "f-1", originatorId: "Event:e1", createdDate: "2026-11-03T08:00:00+00:00", body: "Bedsteforældredag", sender: { name: "Leder" }, embed: { type: "Event", title: "Bedsteforældredag", from: "2026-11-20T08:00:00+00:00", to: "2026-11-20T11:00:00+00:00", location: "Legepladsen" } },
    { originatorId: "Post:broken" },
  ],
};
const notes = {
  childNotes: {
    next: "cur-2",
    result: [
      { id: "n-1", noteType: "Classic", text: "Ida sov 1½ time og spiste godt.", createdAt: "2026-11-04T14:00:00Z", createdBy: { name: { fullName: "Pia Pædagog" } }, images: [{ id: "si-1", width: 10, height: 10, secret: { prefix: "https://img.famly.co/image", key: "k1", path: "p.jpg", expires: "2026-11-05T00:00:00Z" } }], files: [] },
      { id: "n-2", text: "", images: [] },
    ],
  },
};
const conversations = [{ conversationId: "conv-1", lastActivityAt: "2026-11-04T16:00:00+00:00", participants: [{ title: "Pia Pædagog" }, { title: "Mette Hansen" }] }, { title: "no id" }];
const conversation = {
  conversationId: "conv-1",
  messages: [
    { messageId: "m-2", createdAt: "2026-11-04T16:00:00+00:00", body: "Husk skiftetøj i morgen.", author: { title: "Pia Pædagog", me: false }, images: [], files: [] },
    { messageId: "m-1", createdAt: "2026-10-01T09:00:00+00:00", body: "Velkommen!", author: { title: "Pia Pædagog" }, images: [] },
  ],
};

describe("signing in", () => {
  it("reads a token, a refusal, and a challenge", () => {
    expect(loginResult({ data: { me: { authenticateWithPassword: { __typename: "AuthenticationSucceeded", accessToken: "tok-123456" } } } })).toEqual({ kind: "ok", accessToken: "tok-123456" });
    expect(loginResult({ data: { me: { authenticateWithPassword: { __typename: "AuthenticationFailed", errorTitle: "Wrong password" } } } }).kind).toBe("failed");
    expect(loginResult({ data: { me: { authenticateWithPassword: { __typename: "AuthenticationChallenged", loginId: "x" } } } }).kind).toBe("challenged");
    expect(loginResult({}).kind).toBe("unknown");
  });
  it("uses a stable device id per connection", () => {
    expect(deviceIdFor("a")).toBe(deviceIdFor("a"));
    expect(deviceIdFor("a")).not.toBe(deviceIdFor("b"));
    expect(deviceIdFor("a")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
  it("sends the token as x-famly-accesstoken and only calls read paths", async () => {
    const seen: HttpRequest[] = [];
    const transport = async (req: HttpRequest): Promise<HttpResponse> => {
      seen.push(req);
      const body = req.url.includes("/graphql") ? { data: { me: { authenticateWithPassword: { accessToken: "tok-abcdef" } } } } : me;
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(body)), url: req.url };
    };
    const api = new FamlyApi({ transport });
    await api.login("a@example.com", "pw", deviceIdFor("c"));
    await api.me();
    expect(seen[1].url).toBe("https://app.famly.co/api/me/me/me");
    expect(seen[1].headers?.["x-famly-accesstoken"]).toBe("tok-abcdef");
    await expect(api.get("/api/v2/posts/create")).rejects.toBeInstanceOf(FamlyError);
    await expect(api.graphql("CreatePost", {})).rejects.toBeInstanceOf(FamlyError);
  });
  it("sends the token only to Famly's own host, and never follows a redirect with it", async () => {
    const seen: HttpRequest[] = [];
    const transport = async (req: HttpRequest): Promise<HttpResponse> => {
      seen.push(req);
      const body = req.url.includes("/graphql") ? { data: { me: { authenticateWithPassword: { accessToken: "tok-abcdef" } } } } : {};
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(body)), url: req.url };
    };
    const api = new FamlyApi({ transport });
    await api.login("a@example.com", "pw", "d");
    await api.download("https://img.famly.co/image/x/a.jpg", 1000);
    await api.download("https://app.famly.co/files/menu.pdf", 1000);
    expect(seen[1].headers?.["x-famly-accesstoken"]).toBeUndefined();
    expect(seen[1].follow).toBe(2);
    expect(seen[2].headers?.["x-famly-accesstoken"]).toBe("tok-abcdef");
    expect(seen[2].follow).toBe(0);
  });
  it("turns a 401 into an auth error", async () => {
    const api = new FamlyApi({ transport: async (req) => ({ status: 401, headers: {}, body: Buffer.from("{}"), url: req.url }) });
    await expect(api.me()).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("reading Famly", () => {
  it("finds the children on the login (not the institution)", () => {
    expect(childrenFrom(me)).toEqual([{ id: "c-1", name: "Ida Hansen" }]);
  });
  it("reads dates in Famly's shapes", () => {
    expect(famlyDate("2026-11-04T13:10:00+00:00")?.toISOString()).toBe("2026-11-04T13:10:00.000Z");
    expect(famlyDate({ date: "2026-11-04 13:10:00" })?.toISOString()).toBe("2026-11-04T13:10:00.000Z");
    expect(famlyDate("nonsense")).toBeNull();
  });
  it("reads feed posts with pictures and files, and skips broken items", () => {
    const items = feed.feedItems.map(feedItemOf).filter(Boolean);
    expect(items).toHaveLength(2);
    const post = items[0]!;
    expect(post.images).toEqual([{ id: "img-1", url: "https://img.famly.co/image/xyz/2026/11/04/a.jpg", width: 800, height: 600 }]);
    const d = feedSource(post, ["Ida Hansen"]);
    expect(d.externalId).toBe("famly:feed:f-2");
    expect(d.title).toBe("Vi har bagt boller i dag!");
    expect(d.text).toContain("From: Stuen Solsikken");
    expect(d.files[0].name).toBe("Menu uge 46.pdf");
  });
  it("turns an event post into a calendar event (in the calendar link's shape)", () => {
    const ev = eventOf(feedItemOf(feed.feedItems[1])!)!;
    expect(ev).toMatchObject({ key: "famly:f-1", summary: "Bedsteforældredag", location: "Legepladsen", allDay: false });
    expect(ev.start.toISOString()).toBe("2026-11-20T08:00:00.000Z");
    expect(eventOf(feedItemOf(feed.feedItems[0])!)).toBeNull();
  });
  it("reads daily notes with their signed pictures, skipping empty ones", () => {
    const r = notesFrom(notes);
    expect(r.next).toBe("cur-2");
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0].images[0].url).toBe("https://img.famly.co/image/k1/p.jpg?expires=2026-11-05T00%3A00%3A00Z");
    const d = noteSource(r.notes[0], { id: "c-1", name: "Ida Hansen" });
    expect(d.externalId).toBe("famly:note:c-1:n-1");
    expect(d.text).toContain("Child: Ida Hansen");
    expect(d.text).toContain("From: Pia Pædagog");
  });
  it("only keeps https pictures", () => {
    expect(imagesFrom([{ imageId: "x", prefix: "http://img.famly.co", key: "k" }, { imageId: "y", url: "file:///etc/passwd" }])).toEqual([]);
  });
  it("reads conversations and only the new messages, oldest first, as correspondence", () => {
    const convs = conversationsFrom(conversations);
    expect(convs.map((c) => c.id)).toEqual(["conv-1"]);
    const msgs = messagesFrom(conversation);
    expect(msgs.map((m) => m.id)).toEqual(["m-1", "m-2"]);
    const fresh = newMessages(msgs, "2026-10-01T09:00:00.000Z", new Date("2026-09-01T00:00:00Z"));
    expect(fresh.map((m) => m.id)).toEqual(["m-2"]);
    const d = messageSource(convs[0], fresh[0]);
    expect(d).toMatchObject({ kind: "email", threadKey: "famly:conv:conv-1", externalId: "famly:msg:m-2", title: "Famly: Pia Pædagog, Mette Hansen" });
  });
});

describe("children in the graph", () => {
  const people = [
    { id: "p-ida", label: "Ida", aliases: [], kind: "child", props: {} },
    { id: "p-mor", label: "Mette Hansen", aliases: [], kind: null, props: {} },
  ];
  it("uses the tie, the picked person, a full name, or a unique first name among children", () => {
    expect(matchChildren([{ id: "c-1", name: "Ida Hansen" }], people, null).get("c-1")).toBe("p-ida");
    expect(matchChildren([{ id: "c-1", name: "Ida Hansen" }], people, "p-mor").get("c-1")).toBe("p-mor");
    expect(matchChildren([{ id: "c-1", name: "Ida Hansen" }, { id: "c-2", name: "Bo Hansen" }], people, "p-mor").get("c-1")).toBe("p-ida");
    expect(matchChildren([{ id: "c-1", name: "Ida Hansen" }], [{ ...people[1], props: { famlyChildId: "c-1" } }], null).get("c-1")).toBe("p-mor");
  });
  it("proposes the children it can't match, once, with a receipt", () => {
    let n = 0;
    const r = childOps({ children: [{ id: "c-1", name: "Ida Hansen" }, { id: "c-2", name: "Bo Hansen" }], matched: new Map([["c-1", "p-ida"]]), proposed: {}, sourceId: "s-1", mint: () => `new-${++n}`, childKind: true, visibility: "parents" });
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ op: "addNode", type: "person", kind: "child", label: "Bo Hansen", props: { famlyChildId: "c-2" }, receipt: { sourceId: "s-1", quote: "Child: Bo Hansen" } });
    expect(childOps({ children: [{ id: "c-2", name: "Bo Hansen" }], matched: new Map(), proposed: r.proposed, sourceId: "s-1", mint: () => "x", childKind: true, visibility: "parents" }).changes).toHaveLength(0);
  });
});

describe("manifests", () => {
  it("are valid", async () => {
    const { famlyManifest } = await import("./connector");
    const { schoolManifest } = await import("../dk/minuddannelse/connector");
    expect(validateManifest(famlyManifest)).toEqual({ ok: true });
    expect(validateManifest(schoolManifest)).toEqual({ ok: true });
    expect(famlyManifest.region).toBeUndefined();
    expect(schoolManifest.region).toBe("dk");
    expect(schoolManifest.schedule.everyMinutes).toBeGreaterThanOrEqual(60);
    expect(famlyManifest.schedule.everyMinutes).toBeGreaterThanOrEqual(60);
  });
});
