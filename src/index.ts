import type { Env } from "./env";
import { getEasternParts, isInWindow } from "./lib/easternTime";
import { runGenerateJob } from "./jobs/generate";
import { runReviewJob } from "./jobs/review";
import { runPublishGateJob } from "./jobs/publishGate";

type JobName = "generate" | "review" | "publish_gate";

const WEEKDAYS_MWF = new Set(["Mon", "Wed", "Fri"]);

async function alreadyRanToday(db: D1Database, job: JobName, dateStr: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT status FROM job_runs WHERE job_name = ? AND run_date = ?")
    .bind(job, dateStr)
    .first<{ status: string }>();
  return row !== null;
}

async function withJobRunTracking(db: D1Database, job: JobName, dateStr: string, fn: () => Promise<string>): Promise<void> {
  await db.prepare("INSERT INTO job_runs (job_name, run_date, status) VALUES (?, ?, 'running')").bind(job, dateStr).run();
  try {
    const detail = await fn();
    await db
      .prepare("UPDATE job_runs SET status = 'ok', finished_at = datetime('now'), detail = ? WHERE job_name = ? AND run_date = ?")
      .bind(detail, job, dateStr)
      .run();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await db
      .prepare("UPDATE job_runs SET status = 'error', finished_at = datetime('now'), detail = ? WHERE job_name = ? AND run_date = ?")
      .bind(detail, job, dateStr)
      .run();
    throw err;
  }
}

async function dispatch(env: Env, now: Date): Promise<string[]> {
  const et = getEasternParts(now);
  const log: string[] = [];

  // Weekly generation — Sunday ~18:00 ET, preps the coming Mon/Wed/Fri.
  if (et.weekday === "Sun" && isInWindow(et, 18, 0)) {
    if (!(await alreadyRanToday(env.DB, "generate", et.dateStr))) {
      await withJobRunTracking(env.DB, "generate", et.dateStr, () => runGenerateJob(env, et.dateStr));
      log.push("generate: ran");
    }
  }

  if (WEEKDAYS_MWF.has(et.weekday)) {
    // Morning-of Slack review ping — ~08:00 ET.
    if (isInWindow(et, 8, 0)) {
      if (!(await alreadyRanToday(env.DB, "review", et.dateStr))) {
        await withJobRunTracking(env.DB, "review", et.dateStr, () => runReviewJob(env, et.dateStr));
        log.push("review: ran");
      }
    }
    // Publish gate — ~14:30 ET, 30 min before the 3:00 PM post slot.
    if (isInWindow(et, 14, 30)) {
      if (!(await alreadyRanToday(env.DB, "publish_gate", et.dateStr))) {
        await withJobRunTracking(env.DB, "publish_gate", et.dateStr, () => runPublishGateJob(env, et.dateStr));
        log.push("publish_gate: ran");
      }
    }
  }

  return log;
}

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      dispatch(env, new Date(controller.scheduledTime)).then((log) => {
        if (log.length) console.log("Ghostwriter dispatch:", log.join(", "));
      })
    );
  },

  // Manual trigger / health check — not part of the automated flow.
  // curl -X POST https://<worker>/run to force a dispatch check right now.
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/run" && req.method === "POST") {
      const log = await dispatch(env, new Date());
      return Response.json({ ok: true, ran: log });
    }
    if (url.pathname === "/health") {
      return Response.json({ ok: true, et: getEasternParts() });
    }
    return new Response("leverage-linkedin-ghostwriter — see /health or POST /run", { status: 200 });
  },
};
