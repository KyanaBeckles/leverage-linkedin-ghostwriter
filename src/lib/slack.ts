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
}

// The veto emoji is :no_entry_sign: (name "no_entry_sign" in the Slack API).
const VETO_EMOJI = "no_entry_sign";

export async function wasVetoed(botToken: string, channel: string, ts: string): Promise<boolean> {
  const url = `${SLACK_API}/reactions.get?channel=${encodeURIComponent(channel)}&timestamp=${encodeURIComponent(ts)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const json = (await res.json()) as {
    ok: boolean;
    message?: { reactions?: Array<{ name: string; count: number }> };
  };
  if (!json.ok) return false; // fail open on API error — don't silently pull real posts on a transient error
  const reactions = json.message?.reactions ?? [];
  return reactions.some((r) => r.name === VETO_EMOJI && r.count > 0);
}

export async function postAlert(botToken: string, channel: string, text: string, threadTs?: string): Promise<void> {
  await fetch(`${SLACK_API}/chat.postMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel, text, thread_ts: threadTs }),
  });
}
