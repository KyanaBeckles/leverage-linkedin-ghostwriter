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
}

// Publish-gate job (~14:30 ET Mon/Wed/Fri, 30 min before the 3:00 PM slot):
// check each pending_review post's Slack reactions — vetoed posts get
// pulled, everything else goes to Buffer for the 3:00 PM publish.
export async function runPublishGateJob(env: Env, todayEt: string): Promise<string> {
  const { results } = await env.DB
    .prepare("SELECT id, draft_text, edited_text, image_url, scheduled_at, slack_message_ts FROM linkedin_posts WHERE status = 'pending_review' AND date(scheduled_at) = ?")
    .bind(todayEt)
    .all<PendingPost>();

  if (results.length === 0) return `No pending_review posts for ${todayEt}.`;

  let pulled = 0, posted = 0, failed = 0;

  for (const post of results) {
    const vetoed = await wasVetoed(env.SLACK_BOT_TOKEN, env.SLACK_CHANNEL_ID, post.slack_message_ts);

    if (vetoed) {
      await env.DB.prepare("UPDATE linkedin_posts SET status = 'pulled' WHERE id = ?").bind(post.id).run();
      pulled++;
      continue;
    }

    try {
      const text = post.edited_text ?? post.draft_text;
      const externalId = await schedulePostViaBuffer({
        apiKey: env.BUFFER_API_KEY,
        channelId: env.BUFFER_CHANNEL_ID,
        text,
        imageUrl: post.image_url ?? undefined,
        dueAt: new Date(post.scheduled_at),
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
  }

  return `Pulled ${pulled}, posted ${posted}, failed ${failed} (of ${results.length} pending_review posts).`;
}
