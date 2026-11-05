import { describe, expect, it } from "vitest";
import {
  fingerprintOf, foldEvent, framesKey, hashUser, isExpected, messageKey, redactMessage, safeName, stackFrames, toErrorEvent, type ErrorAgg,
} from "./errors";

const SALT = "test-salt";

describe("redactMessage", () => {
  it("removes e-mail addresses, URLs and ids", () => {
    const m = redactMessage("No user anna@example.com for https://my.graph/people/2227e904-28ed-4c5a-8941-acf4ae4da5ab?x=1 (node 2227e904-28ed-4c5a-8941-acf4ae4da5ab)");
    expect(m).not.toMatch(/anna|example\.com|my\.graph|2227e904/);
    expect(m).toContain("<email>");
    expect(m).toContain("<url>");
    expect(m).toContain("<id>");
  });

  it("removes quoted text (what a person wrote)", () => {
    const m = redactMessage(`Cannot save "Emma's birthday party at Bakken" — 'Mikkel' said “no” and «nej»`);
    expect(m).not.toMatch(/Emma|Bakken|Mikkel|nej/);
    expect(m).toContain("Cannot save");
  });

  it("removes credentials and tokens", () => {
    const m = redactMessage("fetch failed: Authorization: Bearer abc.def.ghi password=hunter2 api_key: sk-live_abcdefghijklmnop token='xyz' eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig");
    expect(m).not.toMatch(/abc\.def|hunter2|sk-live|xyz|eyJhbGci/);
    expect(m).toMatch(/password=<redacted>/);
  });

  it("removes CPR numbers, phone numbers and long digit runs, keeps short numbers", () => {
    const m = redactMessage("CPR 010203-1234 phone +45 12 34 56 78 order 1234567 status 404 after 31 ms");
    expect(m).not.toMatch(/010203|1234|12 34 56|1234567/);
    expect(m).toContain("404");
    expect(m).toContain("31 ms");
  });

  it("removes Postgres key values but keeps the column", () => {
    const m = redactMessage("duplicate key value violates unique constraint: Key (email)=(anna@example.com) already exists.");
    expect(m).toContain("Key (email)=(<value>)");
    expect(m).not.toContain("anna");
  });

  it("removes long hex and mixed tokens", () => {
    const m = redactMessage("session 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 and AbCdEf0123456789GhIjKlMnOp");
    expect(m).not.toMatch(/9f86d081|AbCdEf0123/);
  });

  it("caps the length and collapses whitespace", () => {
    expect(redactMessage("a  \n  b")).toBe("a b");
    expect(redactMessage("word ".repeat(200)).length).toBeLessThanOrEqual(300);
    expect(redactMessage(null)).toBe("");
  });
});

describe("stack frames", () => {
  const stack = [
    "TypeError: Cannot read properties of undefined (reading 'label') — Emma's note",
    "    at personProfile (webpack-internal:///(rsc)/./src/lib/people/data.ts:120:15)",
    "    at async Page (/Users/someone/projects/my graph/src/app/(app)/people/[id]/page.tsx:40:3)",
    "    at runMicrotasks (node:internal/process/task_queues:96:5)",
    "    at Object.handle (/app/node_modules/next/dist/server/base-server.js:900:20)",
    "    at /home/secretuser/private/thing.js:1:1",
  ].join("\n");

  it("keeps code locations only, never the message line or home directories", () => {
    const f = stackFrames(stack);
    expect(f[0]).toBe("personProfile (src/lib/people/data.ts:120:15)");
    expect(f[1]).toBe("async Page (src/app/(app)/people/[id]/page.tsx:40:3)");
    expect(f.join("\n")).not.toMatch(/Emma|someone|secretuser|Users/);
    expect(f.some((x) => x.includes("node_modules/next/dist/server/base-server.js"))).toBe(true);
  });

  it("groups by app frames without line numbers", () => {
    const k = framesKey(stackFrames(stack));
    expect(k).toBe("personProfile (src/lib/people/data.ts)|async Page (src/app/(app)/people/[id]/page.tsx)");
  });

  it("cleans error names", () => {
    expect(safeName("TypeError")).toBe("TypeError");
    expect(safeName("<script>")).toBe("script");
    expect(safeName("")).toBe("Error");
  });
});

describe("grouping", () => {
  const base = (over: Partial<Parameters<typeof toErrorEvent>[0]> = {}) => toErrorEvent({
    kind: "error", name: "TypeError", message: "Cannot read properties of undefined (reading 'label')",
    stack: "TypeError: x\n    at personProfile (src/lib/people/data.ts:120:15)", route: "/people/[id]", method: "GET", source: "render", ...over,
  }, SALT);

  it("gives the same fingerprint to the same fault with different values", () => {
    const a = base({ message: "Timed out after 31 ms for anna@example.com" });
    const b = base({ message: "Timed out after 2045 ms for bo@example.com", stack: "TypeError: y\n    at personProfile (src/lib/people/data.ts:121:9)" });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("splits different faults, routes and kinds", () => {
    expect(base().fingerprint).not.toBe(base({ name: "RangeError" }).fingerprint);
    expect(base().fingerprint).not.toBe(base({ route: "/wiki/[slug]" }).fingerprint);
    expect(base().fingerprint).not.toBe(base({ stack: "E\n    at other (src/lib/wiki/index.ts:1:1)" }).fingerprint);
    expect(base().fingerprint).not.toBe(toErrorEvent({ kind: "slow", route: "/people/[id]", method: "GET", durationMs: 2500 }, SALT).fingerprint);
  });

  it("groups slow requests and 5xx answers by route and method", () => {
    const s1 = toErrorEvent({ kind: "slow", route: "/people/2227e904-28ed-4c5a-8941-acf4ae4da5ab", method: "GET", durationMs: 2100 }, SALT);
    const s2 = toErrorEvent({ kind: "slow", route: "/people/[id]", method: "get", durationMs: 9000 }, SALT);
    expect(s1.fingerprint).toBe(s2.fingerprint);
    expect(s1.route).toBe("/people/[id]");
    expect(s1.message).toBe("");
    const st = toErrorEvent({ kind: "status", route: "/api/chat", method: "POST", status: 502 }, SALT);
    expect(st.fingerprint).not.toBe(toErrorEvent({ kind: "status", route: "/api/chat", method: "POST", status: 500 }, SALT).fingerprint);
    expect(st.name).toBe("ServerErrorResponse");
  });

  it("folds messages in the fingerprint key", () => {
    expect(messageKey("After 31 ms")).toBe("after # ms");
    expect(fingerprintOf({ kind: "error", name: "E", message: "a 1", frames: [], route: "/", method: "GET", status: null }))
      .toBe(fingerprintOf({ kind: "error", name: "E", message: "a 2", frames: [], route: "/", method: "GET", status: null }));
  });

  it("hashes users with a salt and never keeps the id", () => {
    const e = base({ userId: "f53aa12e-b667-4f51-bca7-7fafe1ca3a08" });
    expect(e.userHash).toBe(hashUser("f53aa12e-b667-4f51-bca7-7fafe1ca3a08", SALT));
    expect(e.userHash).not.toContain("f53aa12e");
    expect(hashUser("f53aa12e-b667-4f51-bca7-7fafe1ca3a08", "other")).not.toBe(e.userHash);
    expect(JSON.stringify(e)).not.toContain("f53aa12e");
    expect(hashUser(null, SALT)).toBeNull();
  });

  it("keeps nothing but metadata in an event", () => {
    const e = base({ message: `Saving "Noah's diary: I feel sad" failed for anna@example.com`, digest: "12345<script>" });
    const all = JSON.stringify(e);
    expect(all).not.toMatch(/Noah|diary|sad|anna/);
    expect(e.digest).toBe("12345script");
  });

  it("folds repeated events into one group with distinct users", () => {
    const map = new Map<string, ErrorAgg>();
    foldEvent(map, base({ userId: "u1" }));
    foldEvent(map, base({ userId: "u1" }));
    foldEvent(map, base({ userId: "u2" }));
    foldEvent(map, toErrorEvent({ kind: "slow", route: "/", method: "GET", durationMs: 3000 }, SALT));
    foldEvent(map, toErrorEvent({ kind: "slow", route: "/", method: "GET", durationMs: 5000 }, SALT));
    expect(map.size).toBe(2);
    const err = [...map.values()].find((g) => g.event.kind === "error")!;
    expect(err.count).toBe(3);
    expect(err.userHashes.size).toBe(2);
    const slow = [...map.values()].find((g) => g.event.kind === "slow")!;
    expect(slow.maxDurationMs).toBe(5000);
  });

  it("stops adding new groups past the cap", () => {
    const map = new Map<string, ErrorAgg>();
    for (let i = 0; i < 5; i++) foldEvent(map, base({ route: `/r${i}` }), 3);
    expect(map.size).toBe(3);
  });
});

describe("isExpected", () => {
  it("ignores Next control flow and deliberate 4xx responses", () => {
    expect(isExpected(Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" }))).toBe(true);
    expect(isExpected(Object.assign(new Error("x"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" }))).toBe(true);
    expect(isExpected(new Response(null, { status: 401 }))).toBe(true);
    expect(isExpected(new Response(null, { status: 503 }))).toBe(false);
    expect(isExpected(new TypeError("boom"))).toBe(false);
    expect(isExpected(Object.assign(new Error("x"), { digest: "1234567" }))).toBe(false);
  });
});
