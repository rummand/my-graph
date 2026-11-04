/**
 * A small mock of Aula for tests and local development (no real Aula, no real MitID, nobody's data).
 *
 *   GET  /simplesaml/module.php/oidc/authorize.php   "MitID approved": 302 to the redirect URI with ?code&state
 *   POST /simplesaml/module.php/oidc/token.php       authorization_code (checks PKCE S256) and refresh_token (rotates)
 *   GET|POST /api/v{N}/?method=…&access_token=…     the read methods the connector uses; 410 on a retired version
 *
 * Versioned: `state.version` is the live one; lower versions answer 410 (as Aula does), higher ones 404. Tokens expire
 * (`expireAll()`), refresh tokens rotate (a spent one is refused). POSTs need profiles.getProfileContext first and the
 * Csrfp-Token cookie as a header. `messaging.setLastReadMessage` exists and is recorded, so a test can prove the
 * connector never calls it; reading a thread never moves its read marker.
 *
 * Run it on its own: `npx tsx src/lib/connectors/aula/testing/mock-aula.ts [port]`.
 */
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export type MockMessage = { id: string; at: string; sender: { fullName: string; role: string; metadata?: string; profileId?: number }; html: string; type?: string };
export type MockThread = { id: number; subject: string; sensitive?: boolean; /** Listed as ordinary, but opening it asks for MitID step-up. */ stepUpOnOpen?: boolean; regardingChildren?: string[]; institution?: string; recipients?: { fullName: string; role: string }[]; messages: MockMessage[]; lastReadMessageId?: string | null };

export type MockState = {
  version: number;
  accessTtlSec: number;
  tokens: Map<string, number>;
  refresh: Set<string>;
  codes: Map<string, { challenge: string; redirectUri: string }>;
  contexts: Set<string>;
  csrf: string;
  threads: MockThread[];
  posts: { id: number; title: string; html: string; publishAt: string; owner: { fullName: string; role: string }; institution: string; isImportant?: boolean }[];
  events: { id: number; title: string; type: string; startDateTime: string; endDateTime: string; belongsToProfiles: number[]; responseRequired?: boolean; responseDeadline?: string | null; primaryResource?: { name: string } }[];
  presence: { status: number; exitTime?: string; exitWith?: string; checkInTime?: string; checkOutTime?: string; institutionProfile: { id: number } }[];
  albums: { id: number; title: string; creationDate: string; size: number; creator: { name: string } }[];
  calls: { method: string; version: number; httpMethod: string; threadId?: string | null }[];
};

export function defaultState(): MockState {
  return {
    version: 26, accessTtlSec: 3600, tokens: new Map(), refresh: new Set(), codes: new Map(), contexts: new Set(), csrf: b64url(randomBytes(12)),
    threads: [
      {
        id: 9001, subject: "Forældremøde i 3.A", regardingChildren: ["Emma Hansen"], institution: "Bakkeskolen",
        recipients: [{ fullName: "Anna Hansen", role: "guardian" }, { fullName: "Peter Holm", role: "guardian" }, { fullName: "Mette Jensen", role: "employee" }],
        messages: [
          { id: "m1.1", at: "2026-10-20T08:15:00+02:00", sender: { fullName: "Mette Jensen", role: "employee", metadata: "Klasselærer, 3.A", profileId: 501 }, html: "<p>Kære forældre</p><p>Der er forældremøde torsdag den 12. november kl. 17.00 i klassen.</p>" },
          { id: "m1.2", at: "2026-10-21T19:02:00+02:00", sender: { fullName: "Peter Holm", role: "guardian", metadata: "Far til Oskar", profileId: 777 }, html: "Tak, vi kommer begge to." },
        ],
        lastReadMessageId: null,
      },
      {
        id: 9002, subject: "Om Emmas trivsel", sensitive: true, regardingChildren: ["Emma Hansen"], institution: "Bakkeskolen",
        messages: [{ id: "m2.1", at: "2026-10-25T10:00:00+02:00", sender: { fullName: "Mette Jensen", role: "employee" }, html: "Fortroligt." }],
      },
    ],
    posts: [
      { id: 301, title: "Motionsdag fredag", html: "<p>Fredag den 6. november er der motionsdag. Husk løbesko og madpakke.</p>", publishAt: "2026-10-28T12:00:00+01:00", owner: { fullName: "Lars Skov", role: "employee" }, institution: "Bakkeskolen", isImportant: true },
    ],
    events: [
      { id: 7001, title: "Skole-hjem-samtale", type: "event", startDateTime: "2026-11-18T15:00:00+01:00", endDateTime: "2026-11-18T15:20:00+01:00", belongsToProfiles: [1101], responseRequired: true, responseDeadline: "2026-11-10T23:59:00+01:00", primaryResource: { name: "3.A" } },
      { id: 7002, title: "Dansk", type: "lesson", startDateTime: "2026-11-05T08:00:00+01:00", endDateTime: "2026-11-05T08:45:00+01:00", belongsToProfiles: [1101] },
    ],
    presence: [{ status: 3, checkInTime: "07:55", exitTime: "15:30", exitWith: "Mormor", institutionProfile: { id: 1101 } }],
    albums: [{ id: 4001, title: "Udflugt til skoven", creationDate: "2026-10-15T09:00:00+02:00", size: 3, creator: { name: "Lars Skov" } }],
    calls: [],
  };
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const ok = (data: unknown) => ({ status: { code: 0, message: "OK" }, data });

function issue(s: MockState) {
  const access = `at_${b64url(randomBytes(18))}`;
  const refresh = `rt_${b64url(randomBytes(18))}`;
  s.tokens.set(access, Date.now() + s.accessTtlSec * 1000);
  s.refresh.add(refresh);
  return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: s.accessTtlSec };
}

async function bodyOf(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function threadJson(t: MockThread) {
  const latest = t.messages[t.messages.length - 1];
  return {
    id: t.id, subject: t.subject, sensitive: !!t.sensitive, read: false,
    latestMessage: { id: latest.id, sendDateTime: latest.at },
    creator: { fullName: t.messages[0].sender.fullName, mailBoxOwner: { profileType: t.messages[0].sender.role } },
    recipients: (t.recipients ?? []).map((r) => ({ fullName: r.fullName, mailBoxOwner: { profileType: r.role } })),
    regardingChildren: (t.regardingChildren ?? []).map((n, i) => ({ profileId: 1101 + i, displayName: n })),
    institutionCode: "G12345", institutionName: t.institution ?? null,
  };
}

export function handler(s: MockState) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://mock");
    if (url.pathname === "/simplesaml/module.php/oidc/authorize.php") {
      const code = `code_${b64url(randomBytes(12))}`;
      s.codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "", redirectUri: url.searchParams.get("redirect_uri") ?? "" });
      const to = new URL(url.searchParams.get("redirect_uri") ?? "https://app-private.aula.dk");
      to.searchParams.set("code", code);
      to.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: to.toString() });
      return res.end();
    }
    if (url.pathname === "/simplesaml/module.php/oidc/token.php" && req.method === "POST") {
      const form = new URLSearchParams(await bodyOf(req));
      if (form.get("grant_type") === "authorization_code") {
        const c = s.codes.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (!c || b64url(createHash("sha256").update(verifier).digest()) !== c.challenge) return json(res, 400, { error: "invalid_grant" });
        s.codes.delete(form.get("code") ?? "");
        return json(res, 200, issue(s));
      }
      if (form.get("grant_type") === "refresh_token") {
        const r = form.get("refresh_token") ?? "";
        if (!s.refresh.has(r)) return json(res, 400, { error: "invalid_grant" });
        s.refresh.delete(r);
        return json(res, 200, issue(s));
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    const m = url.pathname.match(/^\/api\/v(\d+)\/?$/);
    if (!m) return json(res, 404, { error: "not found" });
    const version = Number(m[1]);
    const method = url.searchParams.get("method") ?? "";
    s.calls.push({ method, version, httpMethod: req.method ?? "GET", threadId: url.searchParams.get("threadId") });
    if (version < s.version) return json(res, 410, { status: { code: 410, message: "Gone" } });
    if (version > s.version) return json(res, 404, { status: { code: 404, message: "Not found" } });
    const token = url.searchParams.get("access_token") ?? "";
    const exp = s.tokens.get(token);
    if (!exp || exp < Date.now()) return json(res, 401, { status: { code: 448, subCode: 9, message: "Invalid access token" } });
    const cookie = `Csrfp-Token=${s.csrf}; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure, PHPSESSID=${token.slice(3, 11)}; Path=/; HttpOnly`;
    const headers = { "set-cookie": cookie.split(", PHP").map((c, i) => (i ? `PHP${c}` : c)) };
    if (req.method === "POST") {
      if (!s.contexts.has(token) || req.headers["csrfp-token"] !== s.csrf) return json(res, 403, { status: { code: 10, subCode: 23, message: "No profile context" } }, headers);
    }
    const p = url.searchParams;
    switch (method) {
      case "profiles.getProfilesByLogin":
        return json(res, 200, ok({ profiles: [{ profileId: 42, displayName: "Anna Hansen", portalRole: "guardian", institutionProfiles: [{ id: 2001, institutionName: "Bakkeskolen" }], children: [{ id: 1101, name: "Emma Hansen", institutionProfile: { id: 1101, institutionName: "Bakkeskolen", institutionCode: "G12345" } }] }] }), headers);
      case "profiles.getProfileContext":
        s.contexts.add(token);
        return json(res, 200, ok({ userId: "u42", institutionProfile: { id: 2001 } }), headers);
      case "messaging.getThreads": {
        const page = Number(p.get("page") ?? 0);
        const sorted = [...s.threads].sort((a, b) => Date.parse(b.messages[b.messages.length - 1].at) - Date.parse(a.messages[a.messages.length - 1].at));
        const slice = sorted.slice(page * 20, page * 20 + 20);
        return json(res, 200, ok({ threads: slice.map(threadJson), page, moreMessagesExist: sorted.length > (page + 1) * 20 }), headers);
      }
      case "messaging.getMessagesForThread": {
        const t = s.threads.find((x) => String(x.id) === p.get("threadId"));
        if (!t) return json(res, 200, { status: { code: 404, message: "No such thread" } }, headers);
        if (t.sensitive || t.stepUpOnOpen) return json(res, 200, { status: { code: 403, subCode: 8, message: "Step-up required" } }, headers);
        const page = Number(p.get("page") ?? 0);
        const newestFirst = [...t.messages].reverse();
        const slice = newestFirst.slice(page * 20, page * 20 + 20);
        return json(res, 200, ok({
          subject: t.subject, lastReadMessageId: t.lastReadMessageId ?? null, moreMessagesExist: newestFirst.length > (page + 1) * 20,
          messages: slice.map((x) => ({ id: x.id, messageType: x.type ?? "Message", sendDateTime: x.at, text: { html: x.html }, sender: { fullName: x.sender.fullName, metadata: x.sender.metadata, profileId: x.sender.profileId, mailBoxOwner: { profileType: x.sender.role } } })),
        }), headers);
      }
      case "messaging.setLastReadMessage": {
        // Present so a test can prove the connector never calls it.
        return json(res, 200, ok(null), headers);
      }
      case "posts.getAllPosts": {
        const index = Number(p.get("index") ?? 0), limit = Number(p.get("limit") ?? 10);
        const sorted = [...s.posts].sort((a, b) => Date.parse(b.publishAt) - Date.parse(a.publishAt));
        return json(res, 200, ok({ posts: sorted.slice(index, index + limit).map((x) => ({ id: x.id, title: x.title, content: { html: x.html }, publishAt: x.publishAt, isImportant: !!x.isImportant, ownerProfile: { fullName: x.owner.fullName, role: x.owner.role, institution: { institutionName: x.institution } } })), moreMessagesExist: sorted.length > index + limit }), headers);
      }
      case "calendar.getEventsByProfileIdsAndResourceIds": {
        const body = JSON.parse((await bodyOf(req)) || "{}") as { instProfileIds?: number[]; start?: string; end?: string };
        const parse = (x?: string) => Date.parse((x ?? "").replace(" ", "T").replace(/\.0000([+-]\d{2})(\d{2})$/, "$1:$2"));
        const from = parse(body.start), to = parse(body.end);
        if (!Number.isFinite(from) || !Number.isFinite(to) || to - from > 50 * 86_400_000) return json(res, 200, { status: { code: 400, message: "Bad range" } }, headers);
        return json(res, 200, ok(s.events.filter((e) => Date.parse(e.startDateTime) >= from && Date.parse(e.startDateTime) <= to && e.belongsToProfiles.some((id) => body.instProfileIds?.includes(id)))), headers);
      }
      case "presence.getDailyOverview":
        return json(res, 200, ok(s.presence.filter((x) => p.getAll("childIds[]").includes(String(x.institutionProfile.id)))), headers);
      case "gallery.getAlbums":
        return json(res, 200, ok(s.albums), headers);
      case "gallery.getMedia":
        return json(res, 200, ok({ results: [1, 2, 3].map((n) => ({ id: Number(p.get("albumId")) * 10 + n, mediaType: "image", file: { url: `https://cdn.example/presigned/${n}?sig=secret` } })) }), headers);
      default:
        return json(res, 200, { status: { code: 400, message: `Unknown method ${method}` } }, headers);
    }
  };
}

export async function startMockAula(port = 0, state: MockState = defaultState()): Promise<{ url: string; state: MockState; close: () => Promise<void>; expireAll: () => void }> {
  const server = http.createServer((req, res) => { handler(state)(req, res).catch((e) => json(res, 500, { error: String(e) })); });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  const { port: p } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${p}`, state,
    close: () => new Promise<void>((r) => server.close(() => r())),
    expireAll: () => { for (const k of state.tokens.keys()) state.tokens.set(k, 0); },
  };
}

/** Mint a token pair directly (tests that skip the sign-in). */
export function mintTokens(state: MockState) {
  return issue(state);
}

if (process.argv[1] && /mock-aula\.ts$/.test(process.argv[1])) {
  const port = Number(process.argv[2] ?? 7311);
  void startMockAula(port).then((m) => console.log(`Mock Aula on ${m.url} (API v${m.state.version})`));
}
