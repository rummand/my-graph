import { describe, expect, it, vi } from "vitest";

const written: { errors: unknown[][]; timings: unknown[][] } = { errors: [], timings: [] };
vi.mock("./store", () => ({
  writeErrors: async (g: unknown[]) => { written.errors.push(g); },
  writeTimings: async (r: unknown[]) => { written.timings.push(r); },
  pruneObservability: async () => {},
}));

const { captureError, flushObservability, onRequestEnd, pendingCounts } = await import("./runtime");

describe("runtime", () => {
  it("collects request timings, slow requests and 5xx answers, then flushes them", async () => {
    onRequestEnd({ route: "/people/[id]", method: "GET", status: 200, rsc: false, ms: 120, errored: false });
    onRequestEnd({ route: "/people/[id]", method: "GET", status: 200, rsc: true, ms: 2600, errored: false });
    onRequestEnd({ route: "/api/chat", method: "POST", status: 500, rsc: false, ms: 40, errored: false });
    onRequestEnd({ route: "/api/chat", method: "POST", status: 500, rsc: false, ms: 40, errored: true }); // already reported
    onRequestEnd({ route: null, method: "GET", status: 200, rsc: false, ms: 1, errored: false }); // static file
    onRequestEnd({ route: "/_next/static/chunk.js", method: "GET", status: 200, rsc: false, ms: 1, errored: false });
    expect(pendingCounts().timings).toBe(3);
    await flushObservability();
    const rows = written.timings.flat() as { route: string; method: string; count: number }[];
    expect(rows.map((r) => `${r.method} ${r.route} ${r.count}`).sort()).toEqual(["GET /people/[id] 1", "POST /api/chat 2", "RSC /people/[id] 1"]);
    const groups = written.errors.flat() as { event: { kind: string; route: string }; count: number }[];
    expect(groups.map((g) => `${g.event.kind} ${g.event.route} ${g.count}`).sort()).toEqual(["slow /people/[id] 1", "status /api/chat 1"]);
    expect(pendingCounts()).toMatchObject({ timings: 0, errors: 0 });
  });

  it("captures thrown errors with metadata only and skips control flow", async () => {
    written.errors = [];
    captureError(Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" }), { route: "/" });
    captureError(new Response(null, { status: 401 }), { route: "/api/me" });
    captureError(new TypeError(`Cannot read "Emma's secret" for anna@example.com`), { route: "/people/[id]", method: "GET", source: "render", userId: "u-1" });
    await flushObservability();
    const groups = written.errors.flat() as { event: { kind: string; message: string; userHash: string | null } }[];
    expect(groups).toHaveLength(1);
    expect(groups[0].event.kind).toBe("error");
    expect(groups[0].event.message).not.toMatch(/Emma|anna/);
    expect(groups[0].event.userHash).toBeTruthy();
    expect(groups[0].event.userHash).not.toBe("u-1");
  });
});
