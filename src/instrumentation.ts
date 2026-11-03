/** Next.js calls register() once when the server starts. */
export async function register() {
  // Keep the import inside this exact check so the edge bundle (middleware) drops it — postgres is Node-only.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.SKIP_DB_SETUP === "1") return; // e.g. during `next build` without a database
    const { prepareDatabase } = await import("@/lib/deploy/migrate");
    await prepareDatabase();
  }
}
