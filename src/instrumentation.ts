import type { Instrumentation } from "next";

/** Next.js calls register() once when the server starts. */
export async function register() {
  // Keep the import inside this exact check so the edge bundle (middleware) drops it — postgres is Node-only.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.SKIP_DB_SETUP === "1") return; // e.g. during `next build` without a database
    // Route timings, slow requests and server errors for the admin console (src/lib/observability): metadata only.
    if (process.env.NEXT_PHASE !== "phase-production-build") {
      const { startObservability } = await import("@/lib/observability/runtime");
      startObservability();
    }
    const { prepareDatabase } = await import("@/lib/deploy/migrate");
    await prepareDatabase();
    // The founder / platform admins are on Ultimate with every add-on from the first request.
    try {
      const { ensurePlatformAdmins } = await import("@/lib/plans/store");
      await ensurePlatformAdmins();
    } catch (err) {
      console.error("[startup] platform admins", err instanceof Error ? err.message : err);
    }
    // The assistant's automations and check-ins (never during `next build`).
    if (process.env.NEXT_PHASE !== "phase-production-build") {
      const { startScheduler } = await import("@/lib/automations");
      startScheduler();
      // Connections (calendar links, mailboxes): every 60s, claims due ones atomically (src/lib/connectors).
      const { startConnectorScheduler } = await import("@/lib/connectors");
      startConnectorScheduler();
      // The reading queue (src/lib/jobs): resumes what a restart interrupted, then reads uploads as they come.
      const { startWorker } = await import("@/lib/jobs/worker");
      startWorker();
      // Nightly encrypted backups, export expiry and account deletions after their grace period (src/lib/backup).
      const { startDataSafetyScheduler } = await import("@/lib/backup");
      startDataSafetyScheduler();
      // HOOK (commitments watch): once a day, clashes, proof of done and contradiction fixes as proposals.
      const { startCommitmentWatch } = await import("@/lib/commitments/watch/scheduler");
      startCommitmentWatch();
    }
  }
}

/**
 * Next.js calls this for every error thrown while rendering, in a route handler, a server action or middleware.
 * Only metadata is kept (src/lib/observability): the route pattern, the error's name, a redacted message, stack frames
 * and a salted hash of the account. Never the request body, headers or query string.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  // Same exact check as register(), so the edge bundle drops the Node-only imports.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { captureError } = await import("@/lib/observability/runtime");
      const { userIdFromCookieHeader } = await import("@/lib/observability/store");
      const userId = await userIdFromCookieHeader(request.headers.cookie).catch(() => null);
      captureError(err, { route: context.routePath, method: request.method, source: context.routeType, userId });
    } catch {
      // Never fail a request because reporting failed.
    }
  }
};
