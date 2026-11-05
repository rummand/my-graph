import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpResponse, Transport } from "@/lib/mcp-client/transport";
import { ConnectorError } from "../errors";
import { validateManifest } from "../manifest";
import { SpondApi, SpondError, spondBase, SPOND_API } from "./client";
import { asConnectorError, spondManifest } from "./connector";
import { spondSnapshot } from "./mapping";
import { EVENTS, GROUPS, PROFILE } from "./testing/fixtures";

const json = (status: number, body: unknown, url = SPOND_API): HttpResponse => ({ status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)), url });

function fake(handler: (r: HttpRequest) => HttpResponse): Transport & { calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const t = (async (r: HttpRequest) => { calls.push(r); return handler(r); }) as Transport & { calls: HttpRequest[] };
  t.calls = calls;
  return t;
}

describe("spond manifest", () => {
  it("is valid, unofficial, for family and personal graphs, international", () => {
    expect(validateManifest(spondManifest)).toEqual({ ok: true });
    expect(spondManifest.status).toBe("unofficial");
    expect(spondManifest.graphKinds).toEqual(["family", "personal"]);
    expect(spondManifest.region).toBeUndefined();
    expect(spondManifest.schedule.everyMinutes).toBeGreaterThanOrEqual(60);
  });
});

describe("spond snapshot", () => {
  const s = spondSnapshot(PROFILE, GROUPS, EVENTS);

  it("keeps only the login's children (one person across groups) and their teams", () => {
    expect(s.account).toEqual({ id: "P-MOM", name: "Mette Holm" });
    expect(s.members.map((m) => [m.name, m.relation, m.teamIds])).toEqual([
      ["Ida Holm", "child", ["G-FOOT", "G-SWIM"]],
      ["Karl Holm", "child", ["G-SWIM"]],
    ]);
    expect(s.members[0].birthDate).toBe("2016-04-02");
    expect(s.teams.map((t) => t.name)).toEqual(["B93 U10 piger", "Svømmeklubben Delfinen"]);
  });

  it("reads events with kind, place, meet time, match info and our answers only", () => {
    expect(s.events.map((e) => e.id)).toEqual(["E-TRAIN", "E-MATCH", "E-SWIM", "E-CANCEL"]);
    const [train, match, swim, cancel] = s.events;
    const ida = s.members[0].key, karl = s.members[1].key;
    expect(train.kind).toBe("training");
    expect(train.meetAt?.toISOString()).toBe("2026-11-10T15:45:00.000Z");
    expect(train.location).toEqual({ name: "Kunstgræsbanen", address: "Peter Bangs Vej 147, 2000 Frederiksberg", lat: 55.68, lon: 12.5 });
    expect(train.responses).toEqual({ [ida]: "unanswered" });
    expect(train.replyBy?.toISOString()).toBe("2026-11-09T18:00:00.000Z");
    expect(train.url).toBe("https://spond.com/client/sponds/E-TRAIN");
    expect(train.description).toContain("drikkedunk");
    expect(match).toMatchObject({ kind: "match", opponent: "KB U10", homeAway: "away" });
    expect(match.meetAt?.toISOString()).toBe("2026-11-15T08:30:00.000Z");
    expect(swim.kind).toBe("tournament");
    expect(swim.responses).toEqual({ [ida]: "unanswered", [karl]: "declined" });
    expect(cancel.cancelled).toBe(true);
  });

  it("copes with empty and odd answers", () => {
    expect(spondSnapshot(null, null, [])).toMatchObject({ members: [], teams: [], events: [] });
    expect(spondSnapshot(PROFILE, "nope", [{ id: 5 }]).events).toEqual([]);
  });
});

describe("spond client", () => {
  it("signs in with auth2/login and sends the bearer token afterwards", async () => {
    const t = fake((r) => {
      if (r.url.endsWith("auth2/login")) return json(200, { accessToken: { token: "tok-1", expiration: "2027-01-01" }, refreshToken: { token: "r" } });
      if (r.url.endsWith("/profile")) return json(200, PROFILE);
      return json(404, {});
    });
    const api = new SpondApi({ transport: t });
    await api.login("mette@example.com", "secret");
    expect(t.calls[0].method).toBe("POST");
    expect(JSON.parse(t.calls[0].body!)).toEqual({ email: "mette@example.com", password: "secret" });
    expect(t.calls[0].headers?.authorization).toBeUndefined();
    await expect(api.profile()).resolves.toEqual(PROFILE);
    expect(t.calls[1].headers?.authorization).toBe("Bearer tok-1");
  });

  it("falls back to the older login endpoint (loginToken)", async () => {
    const t = fake((r) => (r.url.endsWith("auth2/login") ? json(404, {}) : r.url.endsWith("/login") ? json(200, { loginToken: "old" }) : json(200, [])));
    const api = new SpondApi({ transport: t });
    await api.login("a@b.dk", "x");
    await api.groups();
    expect(t.calls.map((c) => new URL(c.url).pathname)).toEqual(["/core/v1/auth2/login", "/core/v1/login", "/core/v1/groups/"]);
    expect(t.calls[2].headers?.authorization).toBe("Bearer old");
  });

  it("a refused sign-in needs the person; a 5xx retries", async () => {
    const api = new SpondApi({ transport: fake(() => json(401, { error: "bad" })) });
    const err = await api.login("a@b.dk", "x").catch((e) => e);
    expect(err).toBeInstanceOf(SpondError);
    expect(err.kind).toBe("auth");
    const mapped = asConnectorError(err) as ConnectorError;
    expect(mapped.kind).toBe("needs_you");
    expect(mapped.code).toBe("spondAuth");
    expect(mapped.message).not.toContain("x");
    const e5 = asConnectorError(new SpondError("down", "http", 503)) as ConnectorError;
    expect(e5.kind).toBe("retry");
  });

  it("reads events in the window, page by page, without duplicates", async () => {
    const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `E${from + i}`, startTimestamp: new Date(Date.UTC(2026, 10, 1) + (from + i) * 3600_000).toISOString() }));
    const t = fake((r) => {
      const u = new URL(r.url);
      if (!u.pathname.endsWith("/sponds/")) return json(404, {});
      // The second page starts at the last start of the first, so it repeats one event.
      return json(200, u.searchParams.get("minStartTimestamp") ? page(199, 10) : page(0, 200));
    });
    const api = new SpondApi({ transport: t });
    const out = await api.events(new Date("2026-10-06T00:00:00Z"), new Date("2027-03-05T00:00:00Z"));
    expect(out).toHaveLength(209);
    const q = new URL(t.calls[0].url).searchParams;
    expect(q.get("minEndTimestamp")).toBe("2026-10-06T00:00:00.000Z");
    expect(q.get("maxStartTimestamp")).toBe("2027-03-05T00:00:00.000Z");
    expect(q.get("scheduled")).toBe("false");
    expect(t.calls.every((c) => (c.method ?? "GET") === "GET")).toBe(true);
  });

  it("uses a local mock only where connectors may reach this computer", () => {
    expect(spondBase("http://127.0.0.1:4100/core/v1", { NODE_ENV: "production" })).toBe(SPOND_API);
    expect(spondBase("http://127.0.0.1:4100/core/v1", { NODE_ENV: "development" })).toBe("http://127.0.0.1:4100/core/v1/");
  });
});
