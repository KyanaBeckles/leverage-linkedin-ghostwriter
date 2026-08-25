// Slack Web API — post the review message, then poll its reactions at the
// publish-gate step. Requires a bot token with chat:write + reactions:read
// scopes, invited into #digital-marketing.

const SLACK_API = "https://slack.com/api";

export interface SlackPostResult {
  ok: boolean;
  ts?: string;
  error?: string;
}

export async function postReviewMessage(
  botToken: string,
  channel: string,
  text: string,
  imageUrl?: string
): Promise<SlackPostResult> {
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text } },
  ];
  if (imageUrl) {
    blocks.push({ type: "image", image_url: imageUrl, alt_text: "Post image" });
  }
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "React with :no_entry_sign: to pull this post before it goes live. No reaction = it posts as scheduled." }],
  });

  try {
    const res = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel, text, blocks }),
    });

    const json = (await res.json()) as { ok: boolean; ts?: string; error?: string };
    return { ok: json.ok, ts: json.ts, error: json.error };
  } catch (err) {
    // Reported per-post by the caller; a network blip on one post shouldn't
    // abort the review pings for the rest of the batch.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// The veto emoji is :no_entry_sign: (name "no_entry_sign" in the Slack API).
const VETO_EMOJI = "no_entry_sign";

/**
 * Reads the veto state of a review message. Retries a transient Slack failure
 * a couple of times and then *throws* rather than guessing: this check is the
 * only thing standing between a draft and Kyana's live LinkedIn feed, so a
 * held post is the cheap failure and an un-vetoable post is the expensive one.
 */
export async function wasVetoed(botToken: string, channel: string, ts: string, attempts = 3): Promise<boolean> {
  const url = `${SLACK_API}/reactions.get?channel=${encodeURIComponent(channel)}&timestamp=${encodeURIComponent(ts)}`;
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } });
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        message?: { reactions?: Array<{ name: string; count: number }> };
      };
      if (json.ok) {
        const reactions = json.message?.reactions ?? [];
        return reactions.some((r) => r.name === VETO_EMOJI && r.count > 0);
      }
      lastError = json.error ?? `HTTP ${res.status}`;
      // A bad token or a message the bot can't see won't fix itself on a retry.
      if (!RETRYABLE_SLACK_ERRORS.has(lastError)) break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }

  throw new Error(`Slack reactions.get failed after ${attempts} attempt(s): ${lastError}`);
}

const RETRYABLE_SLACK_ERRORS = new Set(["ratelimited", "internal_error", "service_unavailable", "fatal_error", "request_timeout"]);

// Best-effort notification: an alert that can't be delivered must never be the
// thing that fails a job, but it should at least land in the Worker logs.
export async function postAlert(botToken: string, channel: string, text: string, threadTs?: string): Promise<void> {
  try {
    const res = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel, text, thread_ts: threadTs }),
    });
    const json = (await res.json()) as { ok: boolean; error?: string };
    if (!json.ok) console.error(`Slack alert not delivered (${json.error ?? "unknown"}): ${text}`);
  } catch (err) {
    console.error(`Slack alert not delivered (${err instanceof Error ? err.message : String(err)}): ${text}`);
  }
}
