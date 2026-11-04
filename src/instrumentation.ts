/** Next.js calls register() once when the server starts. */
export async function register() {
  // Keep the import inside this exact check so the edge bundle (middleware) drops it — postgres is Node-only.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.SKIP_DB_SETUP === "1") return; // e.g. during `next build` without a database
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
    }
  }
}
