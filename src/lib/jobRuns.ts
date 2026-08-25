// Bookkeeping for the three daily jobs. The Worker fires every 15 minutes and
// decides for itself whether a job is due (see easternTime.ts), so this table
// is what stops a job running twice — and what lets a job that blew up on a
// transient error (Claude 529, Slack timeout) get another shot instead of
// silently skipping the day.

export type JobName = "generate" | "review" | "publish_gate";

// How long after its target time a job may still be retried after a failure.
// Long enough to ride out an upstream outage, short enough that `review` can't
// fire so late it collides with the 14:30 publish gate.
export const RETRY_WINDOW_MINUTES = 120;

// A run left in 'running' this long is assumed dead (Worker evicted, CPU limit
// hit) rather than in flight; job durations here are seconds, not minutes.
const STALE_RUNNING_MINUTES = 15;

interface JobRunRow {
  status: "running" | "ok" | "error";
  started_at: string;
}

export interface JobRunState {
  /** Whether the job may start now. */
  runnable: boolean;
  /** True when a previous attempt exists and this would be a retry. */
  retry: boolean;
}

export async function getJobRunState(db: D1Database, job: JobName, dateStr: string): Promise<JobRunState> {
  const row = await db
    .prepare("SELECT status, started_at FROM job_runs WHERE job_name = ? AND run_date = ?")
    .bind(job, dateStr)
    .first<JobRunRow>();

  if (!row) return { runnable: true, retry: false };
  if (row.status === "ok") return { runnable: false, retry: false };
  if (row.status === "error") return { runnable: true, retry: true };

  // 'running': either genuinely in flight, or abandoned by a Worker that died
  // between the INSERT and the final UPDATE.
  const startedAt = Date.parse(`${row.started_at.replace(" ", "T")}Z`);
  const staleFor = Date.now() - startedAt;
  const stale = Number.isFinite(startedAt) && staleFor > STALE_RUNNING_MINUTES * 60_000;
  return { runnable: stale, retry: stale };
}

/**
 * Claims the run, executes `fn`, and records the outcome. The INSERT relies on
 * the UNIQUE(job_name, run_date) constraint to settle races between two
 * overlapping cron invocations: the loser's INSERT throws before `fn` runs.
 */
export async function withJobRunTracking(
  db: D1Database,
  job: JobName,
  dateStr: string,
  retry: boolean,
  fn: () => Promise<string>
): Promise<string> {
  if (retry) {
    await db
      .prepare("UPDATE job_runs SET status = 'running', started_at = datetime('now'), finished_at = NULL, detail = NULL WHERE job_name = ? AND run_date = ?")
      .bind(job, dateStr)
      .run();
  } else {
    await db.prepare("INSERT INTO job_runs (job_name, run_date, status) VALUES (?, ?, 'running')").bind(job, dateStr).run();
  }

  try {
    const detail = await fn();
    await db
      .prepare("UPDATE job_runs SET status = 'ok', finished_at = datetime('now'), detail = ? WHERE job_name = ? AND run_date = ?")
      .bind(detail, job, dateStr)
      .run();
    return detail;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await db
      .prepare("UPDATE job_runs SET status = 'error', finished_at = datetime('now'), detail = ? WHERE job_name = ? AND run_date = ?")
      .bind(detail, job, dateStr)
      .run();
    throw err;
  }
}
