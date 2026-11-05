import { describe, expect, it } from "vitest";
import { cursorOf } from "../state";
import { fakeApi, fakeCtx } from "../oauth/testing";
import { apiBase, buildAuthorizeUrl, providerInfo, scopesFor, unwrapSlackToken } from "../oauth/providers";
import { tokenRequest } from "../oauth/tokens";
import type { HttpRequest } from "@/lib/mcp-client/transport";
import { slackImporter } from "@/lib/importers/slack";
import type { ImportContext } from "@/lib/importers/types";
import { slackConfig, syncSlack, type ImportBatch, type SlackCursor } from "./connector";
import { channelName, dayBatches, plainText, toMessage } from "./map";

const BASE = apiBase({ NODE_ENV: "test" }).slack;
const NOW = new Date("2026-11-04T10:00:00Z");
const ts = (iso: string, n = 0) => `${Math.floor(Date.parse(iso) / 1000)}.${String(n).padStart(6, "0")}`;

const USERS = [
  { id: "U1", name: "anna", real_name: "Anna Holm", profile: { real_name: "Anna Holm", display_name: "anna", email: "anna@acme.dk", title: "Designer" } },
  { id: "U2", name: "bo", profile: { real_name: "Bo Berg", email: "bo@acme.dk" } },
  { id: "B1", name: "deploybot", is_bot: true },
  { id: "U9", name: "gone", deleted: true },
];
const CHANNELS = [
  { id: "C1", name: "general", is_channel: true, is_member: true },
  { id: "C2", name: "secret", is_group: true, is_private: true },
  { id: "D1", is_im: true, user: "U2" },
];

function slackServer(history: Record<string, { ts: string; user?: string; text?: string; subtype?: string; reply_count?: number; thread_ts?: string }[]>) {
  return fakeApi(({ u }) => {
    const method = u.pathname.split("/").pop();
    if (method === "auth.test") return { json: { ok: true, team: "Acme", team_id: "T1", url: "https://acme.slack.com/", user: "anna" } };
    if (method === "users.list") return { json: { ok: true, members: USERS } };
    if (method === "conversations.list") {
      const types = u.searchParams.get("types") ?? "";
      return { json: { ok: true, channels: CHANNELS.filter((c) => types.includes("im") || !c.is_im) } };
    }
    if (method === "conversations.history") {
      const ch = u.searchParams.get("channel")!;
      if (!history[ch]) return { json: { ok: false, error: "channel_not_found" } };
      const oldest = Number(u.searchParams.get("oldest")), latest = Number(u.searchParams.get("latest"));
      return { json: { ok: true, messages: history[ch].filter((m) => Number(m.ts) >= oldest && Number(m.ts) <= latest).reverse(), has_more: false } };
    }
    if (method === "conversations.replies") {
      return { json: { ok: true, messages: [{ ts: u.searchParams.get("ts"), user: "U1", text: "parent" }, { ts: ts("2026-11-03T09:05:00Z"), user: "U2", text: "Yes, <@U1>!" }] } };
    }
    return undefined;
  });
}

function recorder() {
  const batches: { title: string; externalId: string; sensitive?: boolean; json: Record<string, unknown> }[] = [];
  const seen = new Map<string, string>();
  const importBatch: ImportBatch = async (b) => {
    const text = new TextDecoder().decode(b.bytes);
    const duplicate = seen.get(b.externalId) === text;
    seen.set(b.externalId, text);
    if (!duplicate) batches.push({ title: b.title, externalId: b.externalId, sensitive: b.sensitive, json: JSON.parse(text) });
    return { sourceId: `s-${b.externalId}`, duplicate };
  };
  return { batches, importBatch };
}

describe("Slack markup", () => {
  const names = new Map([["U1", "Anna Holm"]]);
  it("turns mentions, channels, links and entities into words", () => {
    expect(plainText("Hi <@U1>, see <#C1|general> and <https://x.dk/a|the plan> &amp; <https://y.dk> <!here> <mailto:a@b.dk|a@b.dk>", names))
      .toBe("Hi @Anna Holm, see #general and the plan (https://x.dk/a) & https://y.dk @here a@b.dk");
  });
  it("names direct and group messages by the people in them", () => {
    expect(channelName({ id: "D1", is_im: true, user: "U1" }, names)).toBe("Anna Holm");
    expect(channelName({ id: "G1", is_mpim: true, name: "mpdm-anna--bo-1" }, names, new Map([["anna", "Anna Holm"], ["bo", "Bo Berg"]]))).toBe("Anna Holm, Bo Berg");
  });
  it("groups messages by UTC day, oldest first", () => {
    const m = (iso: string) => toMessage({ ts: ts(iso), user: "U1", text: "x" }, names, new Map());
    const b = dayBatches({ id: "T1", name: "Acme" }, { id: "C1", name: "general", type: "public" }, [m("2026-11-03T23:59:00Z"), m("2026-11-02T08:00:00Z"), m("2026-11-03T00:01:00Z")]);
    expect(b.map((x) => [x.day, x.messages.length])).toEqual([["2026-11-02", 1], ["2026-11-03", 2]]);
  });
});

describe("Slack sync", () => {
  const history = {
    C1: [
      { ts: ts("2026-11-02T08:00:00Z"), user: "U2", subtype: "channel_join", text: "<@U2> has joined" },
      { ts: ts("2026-11-03T09:00:00Z"), user: "U1", text: "Launch on <!date^1793000000^{date}|Friday>?", reply_count: 1, thread_ts: ts("2026-11-03T09:00:00Z") },
      { ts: ts("2026-11-04T08:30:00Z"), user: "U2", text: "Morning" },
    ],
  };

  it("reads members once, then chosen channels by day, and moves the cursor", async () => {
    const api = slackServer(history);
    const rec = recorder();
    const ctx = fakeCtx("slack", slackConfig.parse({ channels: ["C1", "#nope"], since: "2026-11-01" }), {}, NOW);
    await syncSlack(ctx, { api, base: BASE, importBatch: rec.importBatch });

    const members = rec.batches.find((b) => b.externalId === "slack:T1:members")!;
    expect((members.json.members as { id: string }[]).map((m) => m.id)).toEqual(["U1", "U2"]);
    const days = rec.batches.filter((b) => b.externalId.startsWith("slack:T1:C1:")).map((b) => b.externalId);
    expect(days).toEqual(["slack:T1:C1:2026-11-03", "slack:T1:C1:2026-11-04"]);
    const nov3 = rec.batches.find((b) => b.externalId.endsWith("2026-11-03"))!.json as { messages: { author: string; text: string; replies: { text: string }[] }[] };
    expect(nov3.messages[0]).toMatchObject({ author: "Anna Holm", text: "Launch on Friday?" });
    expect(nov3.messages[0].replies.map((r) => r.text)).toEqual(["Yes, @Anna Holm!"]);
    expect(ctx.logs.some((l) => l.includes('"#nope"'))).toBe(true);

    const cur = cursorOf<SlackCursor>(ctx.state(), "messages")!;
    // Today's midnight: today is read again next time.
    expect(cur.channels!.C1.from).toBe(Date.parse("2026-11-04T00:00:00Z") / 1000);

    // Next run: today gets one more message → the same day's source is updated, nothing else is sent again.
    history.C1.push({ ts: ts("2026-11-04T09:00:00Z"), user: "U1", text: "Coffee?" });
    rec.batches.length = 0;
    await syncSlack(ctx, { api, base: BASE, importBatch: rec.importBatch });
    expect(rec.batches.map((b) => b.externalId)).toEqual(["slack:T1:C1:2026-11-04"]);
    expect((rec.batches[0].json.messages as unknown[]).length).toBe(2);
  });

  it("reads nothing but members until a channel is chosen", async () => {
    const rec = recorder();
    const ctx = fakeCtx("slack", slackConfig.parse({}), {}, NOW);
    await syncSlack(ctx, { api: slackServer(history), base: BASE, importBatch: rec.importBatch });
    expect(rec.batches.map((b) => b.externalId)).toEqual(["slack:T1:members"]);
    expect(ctx.logs.join(" ")).toMatch(/No channel is chosen/);
  });

  it("only reads direct messages with the opt-in, and keeps them sensitive", async () => {
    const dm = { D1: [{ ts: ts("2026-11-04T07:00:00Z"), user: "U2", text: "Private" }] };
    const without = recorder();
    await syncSlack(fakeCtx("slack", slackConfig.parse({ channels: ["D1"], since: "2026-11-04" }), {}, NOW), { api: slackServer(dm), base: BASE, importBatch: without.importBatch });
    expect(without.batches.some((b) => b.externalId.includes("D1"))).toBe(false);

    const withDm = recorder();
    await syncSlack(fakeCtx("slack", slackConfig.parse({ channels: ["D1"], directMessages: true, since: "2026-11-04" }), {}, NOW), { api: slackServer(dm), base: BASE, importBatch: withDm.importBatch });
    const b = withDm.batches.find((x) => x.externalId.includes("D1"))!;
    expect(b.sensitive).toBe(true);
    expect((b.json.channel as { name: string; type: string })).toEqual({ id: "D1", name: "Bo Berg", type: "im" });
  });

  it("asks for a new sign-in when Slack says the token is revoked", async () => {
    const api = fakeApi(() => ({ json: { ok: false, error: "token_revoked" } }));
    await expect(syncSlack(fakeCtx("slack", slackConfig.parse({}), {}, NOW), { api, base: BASE, importBatch: recorder().importBatch }))
      .rejects.toMatchObject({ kind: "needs_you", code: "signInAgain" });
  });

  it("walks a long history a week at a time", async () => {
    const rec = recorder();
    const old = { C1: [{ ts: ts("2026-09-01T10:00:00Z"), user: "U1", text: "Old" }] };
    const ctx = fakeCtx("slack", slackConfig.parse({ channels: ["C1"], since: "2026-08-01" }), {}, NOW);
    await syncSlack(ctx, { api: slackServer(old), base: BASE, importBatch: rec.importBatch });
    // 5 weeks per run from 1 Aug reach 5 Sep: the 1 Sep message is in, and the cursor waits at the next week.
    expect(rec.batches.some((b) => b.externalId === "slack:T1:C1:2026-09-01")).toBe(true);
    expect(cursorOf<SlackCursor>(ctx.state(), "messages")!.channels!.C1.from).toBe(Date.parse("2026-08-01T00:00:00Z") / 1000 + 5 * 7 * 86_400);
  });
});

describe("Slack sign-in", () => {
  const env = { SLACK_CLIENT_ID: "123.456", SLACK_CLIENT_SECRET: "shh", NODE_ENV: "test" };
  it("asks for a user token with read scopes only, DMs only when opted in", () => {
    const p = providerInfo("slack", env);
    const u = new URL(buildAuthorizeUrl(p, "slack", { redirectUri: "https://g.example/cb", state: "s", challenge: "c", scopes: scopesFor("slack", {}) }));
    expect(u.origin + u.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(u.searchParams.get("user_scope")).toBe("channels:history,channels:read,groups:history,groups:read,users:read,users:read.email");
    expect(u.searchParams.get("scope")).toBeNull();
    expect(scopesFor("slack", { directMessages: true })).toEqual(expect.arrayContaining(["im:history", "mpim:read"]));
    expect(scopesFor("slack", {}).some((s) => /write|chat:/.test(s))).toBe(false);
  });

  it("reads the user token out of Slack's answer, and maps refusals", async () => {
    expect(unwrapSlackToken({ ok: true, team: { id: "T1" }, authed_user: { id: "U1", access_token: "xoxp-1", token_type: "user", scope: "channels:read" } }))
      .toEqual({ access_token: "xoxp-1", refresh_token: undefined, expires_in: undefined, scope: "channels:read" });
    const p = providerInfo("slack", env);
    let sent: HttpRequest | null = null;
    const ok = await tokenRequest(async (r) => { sent = r; return { status: 200, headers: {}, url: r.url, body: Buffer.from(JSON.stringify({ ok: true, authed_user: { access_token: "xoxp-9", scope: "channels:read,users:read" } })) }; },
      p, { grant_type: "authorization_code", code: "c", redirect_uri: "https://g.example/cb", code_verifier: "v" });
    expect(ok.accessToken).toBe("xoxp-9");
    expect(sent!.url).toBe("https://slack.com/api/oauth.v2.access");
    expect(String(sent!.body)).toContain("client_secret=shh");
    await expect(tokenRequest(async (r) => ({ status: 200, headers: {}, url: r.url, body: Buffer.from(JSON.stringify({ ok: false, error: "invalid_code" })) }),
      p, { grant_type: "authorization_code", code: "c", redirect_uri: "x" })).rejects.toMatchObject({ code: "signInAgain" });
  });
});

function ctxFor(over: Partial<ImportContext> = {}): ImportContext {
  let n = 0;
  return {
    sourceId: "src1", graphKind: "work", visibility: "private", known: [], existingEdges: new Set(), now: NOW, mint: () => `n${++n}`, locale: "en", ...over,
  };
}

describe("slack importer", () => {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o));
  it("proposes the workspace and its new members, matching known people by email", () => {
    const known = [{ id: "p-bo", type: "person", kind: null, label: "Bo B.", aliases: [], startAt: null, props: { email: "BO@acme.dk" } }];
    const plan = slackImporter.read({ filename: "x", bytes: enc({ kind: "members", team: { id: "T1", name: "Acme", domain: "acme" }, members: [
      { id: "U1", name: "Anna Holm", displayName: "anna", email: "anna@acme.dk", title: "Designer" },
      { id: "U2", name: "Bo Berg", email: "bo@acme.dk" },
    ] }) }, ctxFor({ known })) as ReturnType<typeof slackImporter.read> & { changes: { op: string; [k: string]: unknown }[] };
    const ops = plan.changes;
    expect(ops.filter((c) => c.op === "addNode").map((c) => c.label)).toEqual(["Acme", "Anna Holm"]);
    expect(ops.find((c) => c.op === "addRelationType")).toMatchObject({ key: "member_of" });
    expect(ops.filter((c) => c.op === "addEdge").map((c) => [c.fromId, c.toId])).toEqual([["n2", "n1"], ["p-bo", "n1"]]);
    expect(plan).toMatchObject({ extract: false, counts: { people: 1, matched: 1 } });
  });

  it("reads a channel day as passages for the model, proposing nothing itself", () => {
    const plan = slackImporter.read({ filename: "x", bytes: enc({ kind: "channel", team: { id: "T1", name: "Acme" }, channel: { id: "C1", name: "general", type: "public" }, day: "2026-11-03", messages: [
      { ts: "1793000000.000100", at: "2026-11-03T09:00:00.000Z", author: "Anna Holm", text: "Launch Friday", replies: [{ ts: "1793000300.0", at: "2026-11-03T09:05:00.000Z", author: "Bo Berg", text: "Yes" }] },
    ] }) }, ctxFor()) as { segments: { text: string }[]; changes: unknown[]; extract?: boolean; title?: string };
    expect(plan.segments.map((s) => s.text)).toEqual(["Slack #general in Acme, 2026-11-03", "09:00 UTC Anna Holm: Launch Friday", "  ↳ 09:05 UTC Bo Berg: Yes"]);
    expect(plan.changes).toEqual([]);
    expect(plan.extract).toBe(true);
    expect(plan.title).toBe("Slack #general, 2026-11-03");
  });

  it("never claims an uploaded file and refuses a broken batch with a warning", () => {
    expect(slackImporter.detect({ filename: "export.json", head: new Uint8Array() })).toBe(false);
    const plan = slackImporter.read({ filename: "x", bytes: Buffer.from("{") }, ctxFor()) as { warnings?: string[]; changes: unknown[] };
    expect(plan.changes).toEqual([]);
    expect(plan.warnings?.[0]).toMatch(/valid JSON/);
  });
});

describe("Slack token rotation", () => {
  it("reads a refreshed token from the top level", () => {
    expect(unwrapSlackToken({ ok: true, access_token: "xoxe.xoxp-2", refresh_token: "xoxe-r", expires_in: 43200, token_type: "user" }))
      .toEqual({ access_token: "xoxe.xoxp-2", refresh_token: "xoxe-r", expires_in: 43200, scope: undefined });
    expect(unwrapSlackToken({ ok: false, error: "invalid_refresh_token" })).toMatchObject({ error: "invalid_grant" });
  });
});
