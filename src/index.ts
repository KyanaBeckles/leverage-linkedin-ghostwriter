import type { Env } from "./env";
import { getEasternParts, isInWindow, type EasternParts } from "./lib/easternTime";
import { getJobRunState, withJobRunTracking, RETRY_WINDOW_MINUTES, type JobName } from "./lib/jobRuns";
import { runGenerateJob } from "./jobs/generate";
import { runReviewJob } from "./jobs/review";
import { runPublishGateJob } from "./jobs/publishGate";

const WEEKDAYS_MWF = new Set(["Mon", "Wed", "Fri"]);

interface JobSchedule {
  name: JobName;
  weekdays: Set<string>;
  hour: number;
  minute: number;
  run: (env: Env, todayEt: string) => Promise<string>;
}

const SCHEDULE: JobSchedule[] = [
  // Weekly generation — Sunday ~18:00 ET, preps the coming Mon/Wed/Fri.
  { name: "generate", weekdays: new Set(["Sun"]), hour: 18, minute: 0, run: runGenerateJob },
  // Morning-of Slack review ping — ~08:00 ET.
  { name: "review", weekdays: WEEKDAYS_MWF, hour: 8, minute: 0, run: runReviewJob },
  // Publish gate — ~14:30 ET, 30 min before the 3:00 PM post slot.
  { name: "publish_gate", weekdays: WEEKDAYS_MWF, hour: 14, minute: 30, run: runPublishGateJob },
];

export async function dispatch(env: Env, now: Date): Promise<string[]> {
  const et = getEasternParts(now);
  const log: string[] = [];

  for (const job of SCHEDULE) {
    if (!job.weekdays.has(et.weekday)) continue;
    // Eligible for RETRY_WINDOW_MINUTES after its target time rather than just
    // the one 15-minute slot, so neither an upstream outage nor a cron firing
    // Cloudflare skipped costs the whole day. job_runs still guarantees one
    // successful run.
    if (!isInWindow(et, job.hour, job.minute, RETRY_WINDOW_MINUTES)) continue;

    const state = await getJobRunState(env.DB, job.name, et.dateStr);
    if (!state.runnable) continue;

    try {
      const detail = await withJobRunTracking(env.DB, job.name, et.dateStr, state.retry, () => job.run(env, et.dateStr));
      log.push(`${job.name}: ${state.retry ? "retried" : "ran"} — ${detail}`);
    } catch (err) {
      // Recorded on the job_runs row by withJobRunTracking; keep going so one
      // failing job can't stop the others in this firing.
      log.push(`${job.name}: failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return log;
}

// `/run` can generate drafts and push posts to LinkedIn, so it needs the same
// shared secret whether or not the URL itself stays private.
function isAuthorized(req: Request, env: Env): boolean {
  const expected = env.RUN_SECRET;
  if (!expected) return false;
  const header = req.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return timingSafeEqual(header.slice(prefix.length), expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  // Compare over a fixed length so the loop count doesn't leak the secret's
  // length; an unequal length still fails via the `equal` flag.
  let equal = aBytes.length === bBytes.length ? 1 : 0;
  const length = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < length; i++) {
    equal &= (aBytes[i] ?? 0) === (bBytes[i] ?? 0) ? 1 : 0;
  }
  return equal === 1;
}

export interface HealthResponse {
  ok: boolean;
  et: EasternParts;
}

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      dispatch(env, new Date(controller.scheduledTime))
        .then((log) => {
          if (log.length) console.log("Ghostwriter dispatch:", log.join(" | "));
        })
        // dispatch() already records per-job failures; this only catches the
        // bookkeeping itself falling over (e.g. D1 unreachable).
        .catch((err) => console.error("Ghostwriter dispatch failed:", err))
    );
  },

  // Manual trigger / health check — not part of the automated flow.
  // curl -X POST -H "Authorization: Bearer $RUN_SECRET" https://<worker>/run
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/run" && req.method === "POST") {
      if (!isAuthorized(req, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      const log = await dispatch(env, new Date());
      return Response.json({ ok: true, ran: log });
    }
    // Unconditional publish-gate run, bypassing the ET-window/job_runs guard
    // that /run has — for manually retrying a specific day's posts on demand
    // (e.g. after fixing a credential that caused a real publish failure).
    // Safe to re-call: only acts on rows still in 'pending_review'.
    if (url.pathname === "/run-publish-gate" && req.method === "POST") {
      if (!isAuthorized(req, env)) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      const dateStr = url.searchParams.get("date") ?? getEasternParts().dateStr;
      const detail = await runPublishGateJob(env, dateStr);
      return Response.json({ ok: true, dateStr, detail });
    }
    if (url.pathname === "/health") {
      return Response.json({ ok: true, et: getEasternParts() } satisfies HealthResponse);
    }
    return new Response("leverage-linkedin-ghostwriter — see /health, POST /run, or POST /run-publish-gate?date=YYYY-MM-DD", { status: 200 });
  },
};
