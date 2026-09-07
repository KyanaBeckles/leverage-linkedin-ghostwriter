// Slack Web API — post-only now (no review/veto step, removed 2026-09-04).
// Requires a bot token with chat:write, invited into #digital-marketing.

const SLACK_API = "https://slack.com/api";

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
