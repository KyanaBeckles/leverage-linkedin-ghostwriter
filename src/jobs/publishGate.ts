import type { Env } from "../env";
import { postAlert } from "../lib/slack";
import { schedulePostViaBuffer } from "../lib/buffer";

interface PendingPost {
  id: number;
  draft_text: string;
  edited_text: string | null;
  image_url: string | null;
  scheduled_at: string;
  facebook_status: string | null;
}

// Buffer rejects a customScheduled post whose dueAt has already passed, which
// is reachable when the gate itself runs late (retry window, delayed cron).
const MIN_LEAD_MS = 5 * 60_000;

// Publish-gate job (~14:30 ET Mon/Wed/Fri, 30 min before the 3:00 PM slot):
// publishes every post scheduled for today directly, no review/veto step
// (removed 2026-09-04 at Kyana's request — the Slack veto-reaction check kept
// silently failing on a missing OAuth scope, holding real posts indefinitely).
export async function runPublishGateJob(env: Env, todayEt: string): Promise<string> {
  const { results } = await env.DB
    .prepare("SELECT id, draft_text, edited_text, image_url, scheduled_at, facebook_status FROM linkedin_posts WHERE status = 'scheduled' AND date(scheduled_at) = ?")
    .bind(todayEt)
    .all<PendingPost>();

  if (results.length === 0) return `No posts scheduled for ${todayEt}.`;

  let posted = 0, failed = 0, fbPosted = 0, fbFailed = 0;

  for (const post of results) {
    // When a text-card image exists, the card IS the post - an accompanying
    // caption would just duplicate what's already rendered on the image.
    // Buffer accepts an empty text when an asset is attached.
    const text = post.image_url ? "" : (post.edited_text ?? post.draft_text);
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
      await postAlert(env.SLACK_BOT_TOKEN, env.SLACK_CHANNEL_ID, `⚠️ Post #${post.id} failed to publish to Buffer: ${reason}`);
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
          facebookPostType: "post",
        });
        await env.DB
          .prepare("UPDATE linkedin_posts SET facebook_status = 'posted', facebook_posted_at = datetime('now'), facebook_external_post_id = ? WHERE id = ?")
          .bind(fbExternalId, post.id)
          .run();
        fbPosted++;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await env.DB.prepare("UPDATE linkedin_posts SET facebook_status = 'failed', facebook_failure_reason = ? WHERE id = ?").bind(reason, post.id).run();
        await postAlert(env.SLACK_BOT_TOKEN, env.SLACK_CHANNEL_ID, `⚠️ Post #${post.id} failed to cross-post to Facebook: ${reason}`);
        fbFailed++;
      }
    }
  }

  return `Posted ${posted}, failed ${failed} (of ${results.length} posts scheduled for ${todayEt}). Facebook: posted ${fbPosted}, failed ${fbFailed}.`;
}
