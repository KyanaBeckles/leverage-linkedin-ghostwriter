# leverage-linkedin-ghostwriter

Autonomous LinkedIn ghostwriter for Kyana Beckles / Leverage Assessments, built as
a standalone Cloudflare Worker so its cron schedule doesn't depend on Manus.

Ported from the spec in the Drive folder (`ghostwriter-agent-spec.md`,
`orchestrator-strategy-guidance.md`, `build-checklist.md`, `voice-profile-v3.json`,
`post-topics-seed-v3.json`) — same pipeline, same voice profile, same 3-job
Slack-veto safety net, adapted from Postgres/Drizzle + Manus AGENT cron to
D1/SQLite + Cloudflare Cron Triggers.

## How it works

One Worker, one cron trigger (`*/15 * * * *`, every 15 minutes, all week). The
`scheduled` handler checks the real America/New_York wall-clock time on every
firing and only actually does something when it's the right moment for one of
three jobs — this sidesteps Cloudflare Cron Triggers being UTC-only with no
DST awareness, and a `job_runs` table stops a job firing twice inside its
15-minute window.

| Job | When (ET) | What |
|---|---|---|
| `generate` | Sunday ~18:00 | Picks 3 topics, drafts them in Kyana's voice via Claude, schedules for the coming Mon/Wed/Fri 3:00 PM |
| `review` | Mon/Wed/Fri ~08:00 | Posts each day's draft to `#digital-marketing` for silent-approval review |
| `publish_gate` | Mon/Wed/Fri ~14:30 | Checks for a 🚫 veto reaction; pushes everything else to Buffer for the 3:00 PM publish |

## Setup

### 1. Accounts (same checklist as the original spec)

- **Buffer**: connect the LinkedIn personal profile, upgrade to Essentials ($5/mo), grab the API key + channel ID from Settings.
- **Cloudinary**: free tier, grab cloud name / API key / API secret.
- **Slack**: create a bot with `chat:write` + `reactions:read` scopes, invite it into `#digital-marketing` (channel ID: search Slack for the channel, or `slack_search_channels`).
- **Anthropic**: an API key for Claude.

### 2. D1 database

Already created and seeded directly via the Cloudflare API (database
`leverage-ghostwriter-db`, id in `wrangler.jsonc`) — schema applied from
`migrations/0000_init.sql`, and `voice_profiles` / `post_topics` loaded from
`data/voice-profile-v3.json` / `data/post-topics-seed-v3.json`. If you ever
need to rebuild it from scratch:

```bash
npm install
wrangler d1 create leverage-ghostwriter-db
# copy the returned database_id into wrangler.jsonc
npm run db:migrate:remote
# then re-insert from the two JSON files in data/ — no seed script exists yet,
# they were loaded via direct D1 API calls this round; write one if redoing.
```

### 3. Set secrets

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put SLACK_CHANNEL_ID
wrangler secret put BUFFER_API_KEY
wrangler secret put BUFFER_CHANNEL_ID
wrangler secret put CLOUDINARY_CLOUD_NAME
wrangler secret put CLOUDINARY_API_KEY
wrangler secret put CLOUDINARY_API_SECRET
```

### 4. Deploy

```bash
npm run deploy
```

Cron propagation takes up to 15 minutes globally after first deploy.

### 5. Dry run

`POST /run` on the deployed Worker URL forces an immediate dispatch check
(same logic the cron uses) — useful to verify secrets/bindings are wired up
without waiting for a real ET time window. `GET /health` just echoes the
Worker's current view of Eastern time, useful for confirming DST math.

## Known gaps (v1)

- **No image generation yet.** The spec calls for branded text-card images
  (aphorism/curated_series) and real photos (event_recap). `image_url` is
  wired through the whole pipeline (DB column, Slack preview, Buffer asset)
  but nothing populates it yet — posts go out text-only until this is built.
  The Cloudinary upload helper (`src/lib/cloudinary.ts`) is ready for
  whatever renders the template.
- **Topic balancing is simplified.** `src/jobs/generate.ts` enforces the two
  hard rules (max-1-product-per-batch, no 2 consecutive same mode) but not
  the full rolling-4-week audience/mode analysis from
  `orchestrator-strategy-guidance.md`. Fine for the first several weeks
  since the queue itself is already pre-balanced; revisit once there's real
  posting history to analyze.
- **Buffer's GraphQL API is in beta.** `src/lib/buffer.ts` matches the shape
  documented as of the spec's writing (May 25, 2026 breaking change already
  incorporated) — verify against developers.buffer.com if `publish_gate`
  starts failing.
