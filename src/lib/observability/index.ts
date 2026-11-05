/**
 * Observability (server-only): request timings per route, slow requests and server errors, metadata only.
 * Start with startObservability() (src/instrumentation.ts does), report errors with captureError(), read with the
 * store helpers (the Admin "Errors" and "Performance" pages).
 */
export { captureError, flushObservability, observabilityDisabled, pendingCounts, slowThresholdMs, startObservability } from "./runtime";
export type { CaptureContext } from "./runtime";
export { errorCounts, listErrorGroups, routePerformance, setErrorResolved, timingsSince, userIdFromCookieHeader } from "./store";
export type { ErrorGroupView, PerfSummary, RoutePerf } from "./store";
export type { ErrorKind } from "./errors";
