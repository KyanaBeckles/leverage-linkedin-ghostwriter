import type { Env } from "../env";
import { postReviewMessage } from "../lib/slack";

interface ScheduledPost {
  id: number;
  draft_text: string;
  image_url: string | null;
  scheduled_at: string;
}

// Morning-of job (~08:00 ET Mon/Wed/Fri): post each post scheduled for today
// to #digital-marketing, flip it to pending_review, and store the Slack
// message timestamp so the publish-gate job can check for a veto reaction.
export async function runReviewJob(env: Env, todayEt: string): Promise<string> {
  const { results } = await env.DB
    .prepare("SELECT id, draft_text, image_url, scheduled_at FROM linkedin_posts WHERE status = 'scheduled' AND date(scheduled_at) = ?")
    .bind(todayEt)
    .all<ScheduledPost>();

  if (results.length === 0) return `No posts scheduled for ${todayEt}.`;

  const posted: number[] = [];
  for (const post of results) {
    const text = `*LinkedIn post scheduled for today, 3:00 PM ET* (post #${post.id})\n\n${post.draft_text}`;
    const result = await postReviewMessage(env.SLACK_BOT_TOKEN, env.SLACK_CHANNEL_ID, text, post.image_url ?? undefined);

    if (!result.ok || !result.ts) {
      await env.DB
        .prepare("UPDATE linkedin_posts SET status = 'failed', failure_reason = ? WHERE id = ?")
        .bind(`Slack post failed: ${result.error ?? "unknown"}`, post.id)
        .run();
      continue;
    }

    await env.DB
      .prepare("UPDATE linkedin_posts SET status = 'pending_review', review_ping_at = datetime('now'), slack_message_ts = ? WHERE id = ?")
      .bind(result.ts, post.id)
      .run();
    posted.push(post.id);
  }

  return `Posted ${posted.length}/${results.length} review pings to Slack: ${posted.join(", ")}`;
}
