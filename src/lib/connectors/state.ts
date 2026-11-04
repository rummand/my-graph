/**
 * Connection state, pure. `connections.state` holds one entry per stream plus the failure count:
 *   { streams: { <name>: { cursor, updatedAt, resets } }, failures, lastError }
 * A stream's cursor is only ever replaced together with what it brought in (see run.ts `commit`). Resetting a stream
 * forgets its cursor; the import then skips what it already has (dedupe by the stream's key), so a reset never
 * doubles anything. Back-off: every failed run doubles the wait (15, 30, 60 … capped at 12 hours).
 */
import { MIN_EVERY_MINUTES } from "./manifest";

export type StreamState = { cursor?: unknown; updatedAt?: string; resets?: number };
export type ConnectionState = { streams?: Record<string, StreamState>; failures?: number; lastError?: string | null };

export function readState(raw: unknown): ConnectionState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const s = raw as ConnectionState;
  return { streams: s.streams && typeof s.streams === "object" ? s.streams : {}, failures: Number(s.failures) || 0, lastError: s.lastError ?? null };
}

export function cursorOf<T = unknown>(state: ConnectionState, stream: string): T | undefined {
  return state.streams?.[stream]?.cursor as T | undefined;
}

/** A new state with one stream's cursor replaced (the others untouched). */
export function withCursor(state: ConnectionState, stream: string, cursor: unknown, now = new Date()): ConnectionState {
  const prev = state.streams?.[stream] ?? {};
  return { ...state, streams: { ...(state.streams ?? {}), [stream]: { ...prev, cursor, updatedAt: now.toISOString() } } };
}

/** The one reset path: forget the stream's cursor and count the reset. */
export function resetStream(state: ConnectionState, stream: string, now = new Date()): ConnectionState {
  const prev = state.streams?.[stream] ?? {};
  return { ...state, streams: { ...(state.streams ?? {}), [stream]: { resets: (prev.resets ?? 0) + 1, updatedAt: now.toISOString() } } };
}

/** Does this provider answer mean the stream's cursor expired? (HTTP status or a named reason like "uidvalidity".) */
export function isResetSignal(resetOn: (number | string)[], signal: number | string): boolean {
  return resetOn.some((r) => (typeof r === "number" ? r === Number(signal) : String(r).toLowerCase() === String(signal).toLowerCase()));
}

export const MAX_BACKOFF_MINUTES = 12 * 60;

/** Minutes to wait after `failures` failed runs in a row (0 = on schedule). Never under the 15-minute floor. */
export function backoffMinutes(everyMinutes: number, failures: number): number {
  const base = Math.max(MIN_EVERY_MINUTES, everyMinutes);
  if (failures <= 0) return base;
  return Math.min(MAX_BACKOFF_MINUTES, Math.max(base, MIN_EVERY_MINUTES * 2 ** Math.min(failures, 10)));
}

export function nextRunAfter(now: Date, everyMinutes: number, failures: number): Date {
  return new Date(now.getTime() + backoffMinutes(everyMinutes, failures) * 60_000);
}

export type ConnectionStatus = "ok" | "needs_you" | "error" | "paused";

/** After a run: the connection's status, the next run and the new failure count. needs_you stops the schedule. */
export function afterRun(input: { now: Date; everyMinutes: number; failures: number; outcome: "ok" | "needs_you" | "retry" }): { status: ConnectionStatus; nextRunAt: Date | null; failures: number } {
  if (input.outcome === "ok") return { status: "ok", nextRunAt: nextRunAfter(input.now, input.everyMinutes, 0), failures: 0 };
  if (input.outcome === "needs_you") return { status: "needs_you", nextRunAt: null, failures: input.failures };
  const failures = input.failures + 1;
  return { status: "error", nextRunAt: nextRunAfter(input.now, input.everyMinutes, failures), failures };
}
