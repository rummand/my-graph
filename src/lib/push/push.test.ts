import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ApnsSender, type ApnsRequest, type ApnsTransport } from "./apns";
import { sendToDevices } from "./send";
import {
  JwtCache, buildApnsJwt, buildPayload, classifyApnsResponse, gate, inQuietHours, isDeviceToken, localDay,
  normalizeP8, parseClock, readApnsConfig, type ApnsConfig,
} from "./pure";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const P8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const CONFIG: ApnsConfig = { keyId: "ABC123DEFG", teamId: "TEAM123456", key: P8, bundleId: "app.mygraph.ios", env: "sandbox" };
const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

const b64 = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

describe("APNs JWT", () => {
  it("is ES256 with kid, iss and iat, and verifies with the key's public half", () => {
    const jwt = buildApnsJwt({ keyId: CONFIG.keyId, teamId: CONFIG.teamId, key: P8, issuedAt: 1_800_000_000.7 });
    const [h, c, sig] = jwt.split(".");
    expect(JSON.parse(b64(h).toString())).toEqual({ alg: "ES256", kid: "ABC123DEFG" });
    expect(JSON.parse(b64(c).toString())).toEqual({ iss: "TEAM123456", iat: 1_800_000_000 });
    expect(jwt).not.toMatch(/[=+/]/);
    const raw = b64(sig);
    expect(raw.length).toBe(64); // r||s, not DER
    const ok = verify("SHA256", Buffer.from(`${h}.${c}`), { key: createPublicKey(privateKey), dsaEncoding: "ieee-p1363" }, raw);
    expect(ok).toBe(true);
  });

  it("is reused for 50 minutes, then made again", () => {
    let now = 1_800_000_000;
    const cache = new JwtCache(CONFIG, () => now);
    const first = cache.get();
    now += 49 * 60;
    expect(cache.get()).toBe(first);
    now += 2 * 60;
    expect(cache.get()).not.toBe(first);
  });

  it("reads the key from env in any common paste form, and names (never shows) what's missing", () => {
    const escaped = P8.replace(/\n/g, "\\n");
    const base64 = Buffer.from(P8).toString("base64");
    expect(normalizeP8(escaped)).toBe(P8.trim());
    expect(normalizeP8(base64)).toBe(P8.trim());
    const r = readApnsConfig({ APNS_KEY_ID: "K", APNS_TEAM_ID: "T", APNS_KEY: "secret-value" });
    expect(r).toEqual({ missing: ["APNS_BUNDLE_ID"] });
    expect(JSON.stringify(r)).not.toContain("secret-value");
    const ok = readApnsConfig({ APNS_KEY_ID: "K", APNS_TEAM_ID: "T", APNS_KEY: escaped, APNS_BUNDLE_ID: "b", APNS_ENV: "sandbox" });
    expect("config" in ok && ok.config.env).toBe("sandbox");
  });
});

describe("payloads", () => {
  it("never carries a sensitive reminder's title", () => {
    const p = buildPayload({ kind: "reminder", id: "r1", graphId: "g1", title: "Psykiater: medicin Emma", sensitive: true, aboutNodeId: "n1" }, "da");
    const text = JSON.stringify(p);
    expect(text).not.toContain("Psykiater");
    expect(text).not.toContain("Emma");
    expect(text).not.toContain("n1");
    expect(p.aps.alert.body).toBe("Du har en påmindelse. Åbn My Graph for at se den.");
    expect(p.mg.href).toBe("/");
  });

  it("shows an ordinary reminder's title and opens the person it's about", () => {
    const p = buildPayload({ kind: "reminder", id: "r1", graphId: "g1", title: "Pack gym bag for @[Emma](node:n1)", sensitive: false, aboutNodeId: "n1" }, "en");
    expect(p.aps.alert.title).toBe("Pack gym bag for Emma");
    expect(p.mg).toEqual({ kind: "reminder", href: "/people/n1", graphId: "g1", id: "r1" });
  });

  it("says only 'a new note to review' for a clinical risk flag", () => {
    const en = buildPayload({ kind: "clinical", id: "k1", graphId: "g1" }, "en");
    expect(en.aps.alert).toEqual({ title: "Practice", body: "You have a new note to review." });
    expect(Object.keys(en.mg).sort()).toEqual(["graphId", "href", "id", "kind"]);
    expect(buildPayload({ kind: "clinical", id: "k1", graphId: "g1" }, "da").aps.alert.body).toBe("Du har et nyt notat at gennemgå.");
  });

  it("batches waiting items into one count and links one change set directly", () => {
    const many = buildPayload({ kind: "waiting", graphId: "g1", count: 3, onlyChangeSets: false }, "en");
    expect(many.aps.alert.body).toBe("3 suggestions and changes are waiting for you to look at.");
    expect(many.mg.href).toBe("/");
    const one = buildPayload({ kind: "waiting", graphId: "g1", count: 1, onlyChangeSets: true, changeSetId: "c1" }, "en");
    expect(one.mg.href).toBe("/changes/c1");
    const named = buildPayload({ kind: "waiting", graphId: "g1", graphName: "Familie", multipleGraphs: true, count: 2, onlyChangeSets: true }, "da");
    expect(named.aps.alert.body).toBe("2 forslag og ændringer venter i Familie.");
  });

  it("drops a connection label that looks like more than a name", () => {
    const p = buildPayload({ kind: "connection", id: "c1", graphId: "g1", label: "Mail: re: biopsy results for Emma, please call back asap today" }, "en");
    expect(p.aps.alert.body).not.toContain("biopsy");
  });
});

describe("quiet hours and the cap", () => {
  const tz = "Europe/Copenhagen";
  // 2026-11-04 is CET (UTC+1).
  const at = (utc: string) => new Date(`2026-11-04T${utc}Z`);

  it("wraps midnight", () => {
    expect(inQuietHours(at("21:30:00"), tz, 22 * 60, 7 * 60)).toBe(true); // 22:30 local
    expect(inQuietHours(at("05:30:00"), tz, 22 * 60, 7 * 60)).toBe(true); // 06:30
    expect(inQuietHours(at("06:00:00"), tz, 22 * 60, 7 * 60)).toBe(false); // 07:00
    expect(inQuietHours(at("12:00:00"), tz, 22 * 60, 7 * 60)).toBe(false);
  });

  it("handles a daytime window and none", () => {
    expect(inQuietHours(at("12:00:00"), tz, 12 * 60, 14 * 60)).toBe(true); // 13:00
    expect(inQuietHours(at("12:00:00"), tz, null, null)).toBe(false);
    expect(inQuietHours(at("12:00:00"), tz, 600, 600)).toBe(false);
  });

  it("uses the local day", () => {
    expect(localDay(at("23:30:00"), tz)).toBe("2026-11-05");
    expect(localDay(at("23:30:00"), "UTC")).toBe("2026-11-04");
  });

  it("caps nudges but never a person's own reminder or a risk flag", () => {
    const base = { enabled: true, categories: {}, quiet: false, sentToday: 5, cap: 5 };
    expect(gate({ ...base, category: "waiting" })).toEqual({ send: false, reason: "cap" });
    expect(gate({ ...base, category: "connections" })).toEqual({ send: false, reason: "cap" });
    expect(gate({ ...base, category: "reminders" })).toEqual({ send: true, counted: false });
    expect(gate({ ...base, category: "clinical" })).toEqual({ send: true, counted: false });
    expect(gate({ ...base, category: "waiting", sentToday: 4 })).toEqual({ send: true, counted: true });
  });

  it("holds everything in quiet hours, and respects off switches", () => {
    const base = { enabled: true, categories: {}, quiet: true, sentToday: 0, cap: 5 };
    expect(gate({ ...base, category: "reminders" })).toEqual({ send: false, reason: "quiet_hours" });
    expect(gate({ ...base, category: "clinical" })).toEqual({ send: false, reason: "quiet_hours" });
    expect(gate({ ...base, quiet: false, category: "waiting", categories: { waiting: false } })).toEqual({ send: false, reason: "category_off" });
    expect(gate({ ...base, quiet: false, category: "reminders", enabled: false })).toEqual({ send: false, reason: "disabled" });
  });

  it("parses clock times", () => {
    expect(parseClock("22:00")).toBe(1320);
    expect(parseClock("7:05")).toBe(425);
    expect(parseClock("24:00")).toBeNull();
  });
});

describe("sending and invalid-token cleanup", () => {
  it("classifies APNs answers", () => {
    expect(classifyApnsResponse(200)).toBe("sent");
    expect(classifyApnsResponse(410, "Unregistered")).toBe("invalid_token");
    expect(classifyApnsResponse(400, "BadDeviceToken")).toBe("invalid_token");
    expect(classifyApnsResponse(400, "DeviceTokenNotForTopic")).toBe("invalid_token");
    expect(classifyApnsResponse(400, "PayloadTooLarge")).toBe("failed");
    expect(classifyApnsResponse(403, "ExpiredProviderToken")).toBe("auth");
    expect(classifyApnsResponse(503)).toBe("retry");
  });

  it("sends the right headers, and deletes the token APNs says is gone", async () => {
    const seen: ApnsRequest[] = [];
    const transport: ApnsTransport = async (r) => {
      seen.push(r);
      return r.token === TOKEN_B ? { status: 410, reason: "Unregistered" } : { status: 200 };
    };
    const sender = new ApnsSender(CONFIG, transport);
    const onInvalid = vi.fn(async () => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await sendToDevices(sender, [
      { token: TOKEN_A, locale: "da", environment: "production" },
      { token: TOKEN_B, locale: null, environment: null },
    ], { kind: "clinical", id: "k1", graphId: "g1" }, "en", onInvalid);
    expect(r).toEqual({ sent: 1, invalid: 1, failed: 0 });
    expect(onInvalid).toHaveBeenCalledWith(TOKEN_B);
    expect(onInvalid).toHaveBeenCalledTimes(1);
    expect(seen[0].env).toBe("production");
    expect(seen[1].env).toBe("sandbox");
    expect(seen[0].headers["apns-topic"]).toBe("app.mygraph.ios");
    expect(seen[0].headers["apns-push-type"]).toBe("alert");
    expect(seen[0].headers["apns-collapse-id"]).toBe("k-k1");
    expect(seen[0].headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(JSON.parse(seen[0].body).aps.alert.body).toBe("Du har et nyt notat at gennemgå.");
    expect(JSON.parse(seen[1].body).aps.alert.body).toBe("You have a new note to review.");
    // The key never travels.
    expect(JSON.stringify(seen)).not.toContain("PRIVATE KEY");
  });

  it("retries once with a fresh JWT when APNs says the provider token expired", async () => {
    const auths: string[] = [];
    let now = 1_800_000_000;
    const transport: ApnsTransport = async (r) => {
      auths.push(r.headers.authorization);
      now += 1; // a fresh token gets a new iat
      return auths.length === 1 ? { status: 403, reason: "ExpiredProviderToken" } : { status: 200 };
    };
    const sender = new ApnsSender(CONFIG, transport, () => now);
    const r = await sender.send(TOKEN_A, buildPayload({ kind: "test" }, "en"));
    expect(r.outcome).toBe("sent");
    expect(auths).toHaveLength(2);
    expect(auths[0]).not.toBe(auths[1]);
  });

  it("keeps the token when APNs is down", async () => {
    const sender = new ApnsSender(CONFIG, async () => { throw new Error("ECONNRESET"); });
    const onInvalid = vi.fn(async () => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await sendToDevices(sender, [{ token: TOKEN_A, locale: "en", environment: null }], { kind: "test" }, "en", onInvalid);
    expect(r).toEqual({ sent: 0, invalid: 0, failed: 1 });
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it("accepts only hex device tokens", () => {
    expect(isDeviceToken(TOKEN_A)).toBe(true);
    expect(isDeviceToken("not-a-token")).toBe(false);
    expect(isDeviceToken("ab")).toBe(false);
  });
});
