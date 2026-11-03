/**
 * Session primitives (pure, no Next or DB imports, so middleware, scripts and tests can use them).
 * The browser holds a random 32-byte token; the database only ever stores sha256(token).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { SESSION_TTL_MS, sessionCookieOptions } from "./constants";

export { DEVICE_COOKIE, SESSION_COOKIE, SESSION_TTL_MS, secureCookies, sessionCookieOptions } from "./constants";
export const DEVICE_TTL_S = 400 * 24 * 60 * 60; // browsers cap cookies at 400 days
/** Extend the session (and touch lastSeenAt) at most this often, so reads don't write on every request. */
export const SESSION_TOUCH_MS = 60 * 60 * 1000;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Cheap shape check before touching the database. */
export function isWellFormedToken(token: string | undefined | null): token is string {
  return !!token && TOKEN_RE.test(token);
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function sessionExpiry(now = new Date()): Date {
  return new Date(now.getTime() + SESSION_TTL_MS);
}

/** Sliding expiry: true when the session was last touched long enough ago to extend it. */
export function shouldTouch(lastSeenAt: Date, now = new Date()): boolean {
  return now.getTime() - lastSeenAt.getTime() >= SESSION_TOUCH_MS;
}

export function deviceCookieOptions(env?: { NODE_ENV?: string; APP_URL?: string }) {
  return { ...sessionCookieOptions(env), maxAge: DEVICE_TTL_S };
}

/** Roles whose sign-ins on a new device wait for a parent. */
export function needsDeviceApproval(role: string): boolean {
  return role === "child" || role === "guest";
}

/** A short, readable device label from a User-Agent string ("Safari on iPhone"). */
export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "Chromebook"
    : /Linux/.test(ua) ? "Linux" : null;
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /CriOS|Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /curl|node|undici/i.test(ua) ? "Script" : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown device";
}

/** Only same-site relative paths are allowed as a post-login destination (no open redirects). */
export function safeNext(next: string | null | undefined): string {
  if (!next || typeof next !== "string") return "/";
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (/[\r\n]/.test(next)) return "/";
  if (next.startsWith("/login") || next.startsWith("/setup") || next.startsWith("/api/")) return "/";
  return next;
}
