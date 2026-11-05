import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpResponse, Transport } from "@/lib/mcp-client/transport";
import { ConnectorError } from "../../errors";
import { validateManifest } from "../../manifest";
import { HoldsportApi, HoldsportError, HOLDSPORT_API } from "./client";
import { asConnectorError, holdsportManifest, relationFor } from "./connector";
import { findLoginMember, holdsportSnapshot, rsvpOf, teamsFrom, userFrom } from "./mapping";
import { ACTIVITIES_11, ACTIVITIES_12, MEMBERS_11, TEAMS } from "./testing/fixtures";

const json = (status: number, body: unknown): HttpResponse => ({ status, headers: {}, body: Buffer.from(JSON.stringify(body)), url: HOLDSPORT_API });

function fake(handler: (r: HttpRequest) => HttpResponse): Transport & { calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const t = (async (r: HttpRequest) => { calls.push(r); return handler(r); }) as Transport & { calls: HttpRequest[] };
  t.calls = calls;
  return t;
}

describe("holdsport manifest", () => {
  it("is valid, Danish, for family and personal graphs", () => {
    expect(validateManifest(holdsportManifest)).toEqual({ ok: true });
    expect(holdsportManifest.region).toBe("dk");
    expect(holdsportManifest.graphKinds).toEqual(["family", "personal"]);
    expect(holdsportManifest.schedule.everyMinutes).toBeGreaterThanOrEqual(60);
  });
});

describe("holdsport mapping", () => {
  const me = userFrom(null);
  const member = findLoginMember(MEMBERS_11, me, "IDA@example.com");
  const snap = holdsportSnapshot({ me, teams: teamsFrom(TEAMS), perTeam: [
    { teamId: "11", member, activities: ACTIVITIES_11 },
    { teamId: "12", member: null, activities: ACTIVITIES_12.slice(0, 1) },
  ] }, "child");

  it("finds the login's member by email when Holdsport has no 'me'", () => {
    expect(member).toEqual({ id: "501", name: "Ida Holm", birthDate: "2016-04-02", email: "ida@example.com", phone: "+45 12 34 56 78" });
    expect(findLoginMember(MEMBERS_11, { id: "502", name: null, email: null }, null)?.name).toBe("Sofie Berg");
    expect(findLoginMember(MEMBERS_11, me, "nobody@example.com")).toBeNull();
  });

  it("reads answers from the words first, the code after", () => {
    expect(rsvpOf(0, "Ikke svaret")).toBe("unanswered");
    expect(rsvpOf(1, "Tilmeldt")).toBe("accepted");
    expect(rsvpOf(9, "Afmeldt")).toBe("declined");
    expect(rsvpOf(4, null)).toBe("waiting");
    expect(rsvpOf(2, "")).toBe("declined");
    expect(rsvpOf(null, null)).toBe("unanswered");
  });

  it("makes one member (the child) with the club from the activities, and the events with our answers", () => {
    expect(snap.members).toEqual([{ key: "u:501", name: "Ida Holm", relation: "child", birthDate: "2016-04-02", email: "ida@example.com", phone: "+45 12 34 56 78", teamIds: ["11"] }]);
    expect(snap.teams.find((t) => t.id === "11")?.club).toBe("Frederiksberg IF");
    const [train, match, cancelled, tourney] = snap.events;
    expect(train).toMatchObject({ id: "9001", kind: "training", teamId: "11", responses: { "u:501": "unanswered" }, cancelled: false });
    expect(train.location?.name).toBe("Frederiksberg Idrætspark, bane 3");
    expect(train.start.toISOString()).toBe("2026-11-10T16:00:00.000Z");
    expect(train.description).toBe("Husk benskinner");
    expect(match).toMatchObject({ kind: "match", responses: { "u:501": "accepted" } });
    expect(match.meetAt?.toISOString()).toBe("2026-11-14T08:30:00.000Z");
    expect(cancelled.cancelled).toBe(true);
    expect(tourney).toMatchObject({ kind: "tournament", teamId: "12", responses: { "u:501": "declined" } });
  });

  it("uses the picked person's name when Holdsport doesn't say who the login is", () => {
    const s = holdsportSnapshot({ me, teams: teamsFrom(TEAMS), perTeam: [{ teamId: "11", member: null, activities: [] }] }, "child", "Ida");
    expect(s.members).toMatchObject([{ key: "login", name: "Ida", teamIds: ["11"] }]);
    expect(holdsportSnapshot({ me, teams: [], perTeam: [] }, "child").members).toEqual([]);
  });

  it("decides who the login is to the person connecting", () => {
    const v = (graphKind: string, name: string) => ({ viewer: { graphKind, name } as never, config: { sportsTeams: [], visibility: "parents" as const } });
    expect(relationFor(v("family", "Mette Holm"), "Ida Holm")).toBe("child");
    expect(relationFor(v("family", "Mette Holm"), "Mette Holm")).toBe("self");
    expect(relationFor(v("personal", "Mette Holm"), "Ida Holm")).toBe("self");
  });
});

describe("holdsport client", () => {
  it("sends basic auth and pages activities until past the window", async () => {
    const t = fake((r) => {
      const u = new URL(r.url);
      if (u.pathname === "/v1/teams") return json(200, TEAMS);
      if (u.pathname === "/v1/me") return json(404, {});
      if (u.pathname === "/v1/teams/12/activities") return json(200, ACTIVITIES_12);
      return json(404, {});
    });
    const api = new HoldsportApi({ transport: t, user: "ida@example.com", password: "pw" });
    expect(await api.teams()).toHaveLength(2);
    expect(await api.me()).toBeNull();
    const acts = await api.activities("12", new Date("2026-10-06T00:00:00Z"), new Date("2027-03-05T00:00:00Z"));
    expect(acts.map((a) => (a as { id: number }).id)).toEqual([9101]);
    expect(t.calls[0].headers?.authorization).toBe(`Basic ${Buffer.from("ida@example.com:pw").toString("base64")}`);
    const q = new URL(t.calls[2].url).searchParams;
    expect([q.get("date"), q.get("page"), q.get("per_page")]).toEqual(["2026-10-06", "1", "100"]);
    expect(t.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("a refused login needs the person", async () => {
    const api = new HoldsportApi({ transport: fake(() => json(401, {})), user: "u", password: "p" });
    const err = await api.teams().catch((e) => e);
    expect(err).toBeInstanceOf(HoldsportError);
    const mapped = asConnectorError(err) as ConnectorError;
    expect([mapped.kind, mapped.code]).toEqual(["needs_you", "holdsportAuth"]);
    expect((asConnectorError(new HoldsportError("x", "rate", 429)) as ConnectorError).kind).toBe("retry");
  });
});
