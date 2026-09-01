import type { Env } from "../env";
import { wasVetoed, postAlert } from "../lib/slack";
import { schedulePostViaBuffer } from "../lib/buffer";

interface PendingPost {
  id: number;
  draft_text: string;
  edited_text: string | null;
  image_url: string | null;
  scheduled_at: string;
  slack_message_ts: string;
  facebook_status: string | null;
}

// Buffer rejects a customScheduled post whose dueAt has already passed, which
// is reachable when the gate itself runs late (retry window, delayed cron).
const MIN_LEAD_MS = 5 * 60_000;

// Publish-gate job (~14:30 ET Mon/Wed/Fri, 30 min before the 3:00 PM slot):
// check each pending_review post's Slack reactions — vetoed posts get
// pulled, everything else goes to Buffer for the 3:00 PM publish.
export async function runPublishGateJob(env: Env, todayEt: string): Promise<string> {
  const { results } = await env.DB
    .prepare("SELECT id, draft_text, edited_text, image_url, scheduled_at, slack_message_ts, facebook_status FROM linkedin_posts WHERE status = 'pending_review' AND date(scheduled_at) = ?")
    .bind(todayEt)
    .all<PendingPost>();

  const stranded = await reportStrandedPosts(env, todayEt);

  if (results.length === 0) return `No pending_review posts for ${todayEt}.${stranded}`;

  let pulled = 0, posted = 0, failed = 0, held = 0, fbPosted = 0, fbFailed = 0;

  for (const post of results) {
    let vetoed: boolean;
    try {
      vetoed = await wasVetoed(env.SLACK_BOT_TOKEN, env.SLACK_CHANNEL_ID, post.slack_message_ts);
    } catch (err) {
      // Veto state unknown: leave the post in pending_review so a later retry
      // (or a manual POST /run) can still publish it, rather than publishing
      // something that may have been vetoed.
      const reason = err instanceof Error ? err.message : String(err);
      await postAlert(
        env.SLACK_BOT_TOKEN,
        env.SLACK_CHANNEL_ID,
        `⚠️ Post #${post.id} held — couldn't read the veto reaction, so it was not published. ${reason}`,
        post.slack_message_ts
      );
      held++;
      continue;
    }

    if (vetoed) {
      await env.DB.prepare("UPDATE linkedin_posts SET status = 'pulled' WHERE id = ?").bind(post.id).run();
      pulled++;
      continue;
    }

    const text = post.edited_text ?? post.draft_text;
    const scheduledAt = new Date(post.scheduled_at);
    const dueAt = new Date(Math.max(scheduledAt.getTime(), Date.now() + MIN_LEAD_MS));

    try {
      const externalId = await schedulePostViaBuffer({
        apiKey: env.BUFFER_API_KEY,
        channelId: env.BUFFER_CHANNEL_ID,
        text,
        imageUrl: post.image_url ?? undefined,
        dueAt,
      });
      await env.DB
        .prepare("UPDATE linkedin_posts SET status = 'posted', posted_at = datetime('now'), external_post_id = ? WHERE id = ?")
        .bind(externalId, post.id)
        .run();
      posted++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await env.DB.prepare("UPDATE linkedin_posts SET status = 'failed', failure_reason = ? WHERE id = ?").bind(reason, post.id).run();
      await postAlert(env.SLACK_BOT_TOKEN, env.SLACK_CHANNEL_ID, `⚠️ Post #${post.id} failed to publish to Buffer: ${reason}`, post.slack_message_ts);
      failed++;
    }

    // Cross-post the same approved text to Facebook. Independent of the
    // LinkedIn outcome above — a Buffer/LinkedIn hiccup shouldn't also block
    // Facebook, and vice versa. Idempotent: skips a post already marked
    // facebook_status = 'posted' (relevant on a manual /run-publish-gate retry).
    if (post.facebook_status !== "posted") {
      try {
        const fbExternalId = await schedulePostViaBuffer({
          apiKey: env.BUFFER_API_KEY,
          channelId: env.BUFFER_FACEBOOK_CHANNEL_ID,
          text,
          imageUrl: post.image_url ?? undefined,
          dueAt,
        });
        await env.DB
          .prepare("UPDATE linkedin_posts SET facebook_status = 'posted', facebook_posted_at = datetime('now'), facebook_external_post_id = ? WHERE id = ?")
          .bind(fbExternalId, post.id)
          .run();
        fbPosted++;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await env.DB.prepare("UPDATE linkedin_posts SET facebook_status = 'failed', facebook_failure_reason = ? WHERE id = ?").bind(reason, post.id).run();
        await postAlert(env.SLACK_BOT_TOKEN, env.SLACK_CHANNEL_ID, `⚠️ Post #${post.id} failed to cross-post to Facebook: ${reason}`, post.slack_message_ts);
        fbFailed++;
      }
    }
  }

  const summary = `Pulled ${pulled}, posted ${posted}, failed ${failed}, held ${held} (of ${results.length} pending_review posts). Facebook: posted ${fbPosted}, failed ${fbFailed}.`;
  return `${summary}${stranded}`;
}

// A post scheduled for today that never reached pending_review never got its
// review ping, so it can't be vetoed and must not be auto-published — but it
// also shouldn't disappear without anyone noticing.
async function reportStrandedPosts(env: Env, todayEt: string): Promise<string> {
  const { results } = await env.DB
    .prepare("SELECT id, status, failure_reason FROM linkedin_posts WHERE status IN ('scheduled', 'failed') AND date(scheduled_at) = ?")
    .bind(todayEt)
    .all<{ id: number; status: string; failure_reason: string | null }>();

  if (results.length === 0) return "";

  const listing = results.map((p) => `#${p.id} (${p.status}${p.failure_reason ? `: ${p.failure_reason}` : ""})`).join(", ");
  await postAlert(
    env.SLACK_BOT_TOKEN,
    env.SLACK_CHANNEL_ID,
    `⚠️ ${results.length} post(s) scheduled for today never made it to review and were not published: ${listing}`
  );
  return ` Stranded: ${listing}.`;
}
