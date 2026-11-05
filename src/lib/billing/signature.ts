/**
 * Stripe webhook signatures (pure). Stripe signs `${timestamp}.${raw body}` with HMAC-SHA256 using the endpoint's
 * signing secret and sends `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>…]`. Verify against the exact raw bytes:
 * parsing and re-serialising the JSON first would break the signature.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const DEFAULT_TOLERANCE_SEC = 300;

export type SignatureResult = { ok: true } | { ok: false; reason: "missing" | "malformed" | "too_old" | "mismatch" };

export function parseSignatureHeader(header: string | null | undefined): { t: number; v1: string[] } | null {
  if (!header) return null;
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    if (k === "t" && /^\d+$/.test(val)) t = Number(val);
    else if (k === "v1" && /^[0-9a-f]+$/i.test(val)) v1.push(val.toLowerCase());
  }
  return t === null || !v1.length ? null : { t, v1 };
}

export function computeSignature(payload: string, timestamp: number, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex");
}

/** A header as Stripe would send it (tests and local mocks). */
export function signPayload(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${computeSignature(payload, timestamp, secret)}`;
}

export function verifySignature(i: {
  payload: string; header: string | null | undefined; secret: string; nowSec?: number; toleranceSec?: number;
}): SignatureResult {
  if (!i.header) return { ok: false, reason: "missing" };
  const parsed = parseSignatureHeader(i.header);
  if (!parsed) return { ok: false, reason: "malformed" };
  const now = i.nowSec ?? Math.floor(Date.now() / 1000);
  const tol = i.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  if (Math.abs(now - parsed.t) > tol) return { ok: false, reason: "too_old" };
  const expected = Buffer.from(computeSignature(i.payload, parsed.t, i.secret), "hex");
  for (const sig of parsed.v1) {
    const got = Buffer.from(sig, "hex");
    if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true };
  }
  return { ok: false, reason: "mismatch" };
}
