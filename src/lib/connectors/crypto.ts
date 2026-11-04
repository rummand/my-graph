/**
 * Connector secrets at rest: AES-256-GCM with a random 12-byte IV per write and the connection id as associated data
 * (a secret copied onto another connection row won't decrypt). The key is CONNECTOR_KEY (32 bytes as hex or base64,
 * or any passphrase, which is stretched), else derived from SESSION_SECRET with HKDF. Server-only.
 * Secrets are never returned by an API, never logged and never sent to mux.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";
let cached: { source: string; key: Buffer } | null = null;

/** The 32-byte key, from the environment (exported for the tests; pass an env to compute without caching). */
export function connectorKey(env: Record<string, string | undefined> = process.env): Buffer {
  const explicit = env.CONNECTOR_KEY?.trim();
  const session = env.SESSION_SECRET?.trim();
  const source = explicit ? `k:${explicit}` : session ? `s:${session}` : "";
  if (env === process.env && cached?.source === source) return cached.key;
  let key: Buffer;
  if (explicit) {
    if (/^[0-9a-f]{64}$/i.test(explicit)) key = Buffer.from(explicit, "hex");
    else {
      const b = Buffer.from(explicit, "base64");
      key = b.length === 32 && /^[A-Za-z0-9+/=_-]+$/.test(explicit) ? b : createHash("sha256").update(`my-graph connectors|${explicit}`).digest();
    }
  } else if (session) {
    key = Buffer.from(hkdfSync("sha256", session, "my-graph", "connector secrets v1", 32));
  } else if (env.NODE_ENV !== "production") {
    key = createHash("sha256").update("my-graph development connector key").digest();
  } else {
    throw new Error("Set CONNECTOR_KEY (or SESSION_SECRET) so connection passwords can be stored encrypted.");
  }
  if (env === process.env) cached = { source, key };
  return key;
}

export function encryptSecrets(secrets: Record<string, string>, aad: string, key: Buffer = connectorKey()): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(JSON.stringify(secrets), "utf8"), c.final()]);
  return `${VERSION}:${Buffer.concat([iv, c.getAuthTag(), body]).toString("base64")}`;
}

/** Decrypts; throws when the key is wrong or the text was tampered with. Empty input → {}. */
export function decryptSecrets(text: string | null | undefined, aad: string, key: Buffer = connectorKey()): Record<string, string> {
  if (!text) return {};
  const [ver, b64] = text.split(":", 2);
  if (ver !== VERSION || !b64) throw new Error("Unknown secret format.");
  const raw = Buffer.from(b64, "base64");
  if (raw.length < 29) throw new Error("Secret is too short.");
  const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(raw.subarray(12, 28));
  const out = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8")) as unknown;
  if (!out || typeof out !== "object" || Array.isArray(out)) throw new Error("Secret is not an object.");
  return Object.fromEntries(Object.entries(out as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>;
}

/** Replace every secret value that appears in a text (an error message, a URL) with "…", so it can be logged or shown. */
export function redact(text: string, secrets: Record<string, string>): string {
  let out = text;
  for (const v of Object.values(secrets)) {
    if (!v || v.length < 4) continue;
    out = out.split(v).join("…");
    try {
      const u = new URL(v);
      // A secret URL often leaks as its path or query alone.
      if (u.pathname.length > 8) out = out.split(u.pathname).join("/…");
      if (u.search.length > 8) out = out.split(u.search).join("?…");
    } catch { /* not a URL */ }
  }
  return out;
}
