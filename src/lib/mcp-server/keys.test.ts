import { describe, expect, it } from "vitest";
import { credentialForKey, KEYS_MAX, listKeys, makeKey, revokeKey } from "./keys";
import { memoryStore } from "./store-memory";
import { bearerOf, hashToken, isKeyToken, newKey, verifierMatches } from "./tokens";

const USER = "11111111-1111-4111-8111-111111111111";
const G = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const store = () => memoryStore({ graphs: { [USER]: { [G]: { name: "Family", canWrite: true }, [RO]: { name: "Shared", canWrite: false } } } });

describe("personal access keys", () => {
  it("are random, prefixed, and kept only as a SHA-256 hash", async () => {
    const a = newKey(), b = newKey();
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^mgk_[A-Za-z0-9_-]{43}$/);
    expect(a.hash).toBe(hashToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.prefix.startsWith(a.token.slice(0, 10))).toBe(true);
    const s = store();
    const made = await makeKey(s, USER, { name: "Claude Code", scope: "read", graphId: G });
    expect(JSON.stringify(s.tables.keys)).not.toContain(made.key);
    expect(s.tables.keys[0].tokenHash).toBe(hashToken(made.key));
  });

  it("works in its one graph, as its person, until revoked", async () => {
    const s = store();
    const made = await makeKey(s, USER, { name: "Laptop", scope: "propose", graphId: G });
    expect(await credentialForKey(s, made.key)).toMatchObject({ kind: "key", userId: USER, graphId: G, scope: "propose" });
    expect(await credentialForKey(s, made.key.slice(0, -1) + (made.key.endsWith("a") ? "b" : "a"))).toBeNull();
    expect(await revokeKey(s, "someone-else", made.out.id)).toBeNull();
    expect(await revokeKey(s, USER, made.out.id)).not.toBeNull();
    expect(await credentialForKey(s, made.key)).toBeNull();
    expect(await listKeys(s, USER)).toHaveLength(0);
  });

  it("refuses a graph the person isn't in, propose where they can't write, and too many keys", async () => {
    const s = store();
    await expect(makeKey(s, USER, { name: "x", scope: "read", graphId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })).rejects.toMatchObject({ status: 404 });
    await expect(makeKey(s, USER, { name: "x", scope: "propose", graphId: RO })).rejects.toMatchObject({ status: 403 });
    await expect(makeKey(s, USER, { name: "   ", scope: "read", graphId: G })).rejects.toMatchObject({ status: 400 });
    for (let i = 0; i < KEYS_MAX; i++) await makeKey(s, USER, { name: `k${i}`, scope: "read", graphId: G });
    await expect(makeKey(s, USER, { name: "one more", scope: "read", graphId: G })).rejects.toMatchObject({ status: 409 });
  });

  it("stop when the account can't be used", async () => {
    const s = store();
    const made = await makeKey(s, USER, { name: "x", scope: "read", graphId: G });
    expect(await credentialForKey({ ...s, userActive: async () => false }, made.key)).toBeNull();
  });
});

describe("token helpers", () => {
  it("reads a bearer token only from the header", () => {
    expect(bearerOf("Bearer mgk_abc")).toBe("mgk_abc");
    expect(bearerOf("bearer   mgk_abc ")).toBe("mgk_abc");
    expect(bearerOf("Basic xyz")).toBe("");
    expect(bearerOf(null)).toBe("");
    expect(isKeyToken("mgk_short")).toBe(false);
  });
  it("checks PKCE S256", () => {
    expect(verifierMatches("short", "x")).toBe(false);
  });
});
