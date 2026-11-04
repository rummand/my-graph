/**
 * Background jobs (server-only): a durable queue in Postgres and the in-process worker that drains it.
 * Reading files goes through here so a restart never loses work: see ./queue (enqueue, claim, lease),
 * ./worker (polling, concurrency, shutdown), ./manage (what a viewer sees and may do) and ./policy (the rules).
 */
export { enqueueJob, enqueueSourceRead, waitForJob, backfillSources, requeueOrphans, liveJobsFor, type LiveJob } from "./queue";
export { graphQueue, resumeStalled, retryJob, cancelJob, queueRebuild, type JobView, type QueueView } from "./manage";
export { startWorker, workerState } from "./worker";
export type { JobKind, JobProgress, JobStatus } from "./policy";
