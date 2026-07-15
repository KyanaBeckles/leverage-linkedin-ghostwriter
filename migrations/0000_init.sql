-- Ported from ghostwriter-schema.ts (Postgres/Drizzle) to D1/SQLite.
-- Enums become CHECK constraints since SQLite has no native enum type.

CREATE TABLE voice_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL,
  tone TEXT NOT NULL,
  sentence_rhythm TEXT NOT NULL,
  structural_patterns TEXT NOT NULL, -- JSON array
  recurring_topics TEXT NOT NULL,    -- JSON array
  signature_phrases TEXT NOT NULL,   -- JSON array
  avoid_list TEXT,                   -- JSON array
  example_excerpts TEXT NOT NULL,    -- JSON array
  source_post_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_active INTEGER NOT NULL DEFAULT 1 -- 0/1 boolean
);

CREATE TABLE post_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  source_context TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('event_recap', 'aphorism', 'curated_series')),
  audience_tag TEXT NOT NULL CHECK (audience_tag IN ('public_sector', 'associations', 'product', 'both')),
  priority INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE linkedin_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER REFERENCES post_topics(id),
  voice_profile_id INTEGER NOT NULL REFERENCES voice_profiles(id),
  draft_text TEXT NOT NULL,
  edited_text TEXT,
  image_url TEXT,
  status TEXT NOT NULL DEFAULT 'drafted' CHECK (status IN
    ('queued', 'drafted', 'scheduled', 'pending_review', 'approved', 'posted', 'pulled', 'failed')),
  scheduled_at TEXT,
  review_ping_at TEXT,
  slack_message_ts TEXT,
  posted_at TEXT,
  external_post_id TEXT, -- Buffer post ID
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE post_generation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES linkedin_posts(id),
  prompt_used TEXT NOT NULL,
  model_response TEXT NOT NULL,
  tokens_used INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tracks which of the 3 daily jobs have already fired today, since Cloudflare
-- cron is UTC-only with no DST awareness — the scheduled handler runs every
-- 15 minutes and checks real America/New_York time itself, so this table is
-- what prevents it from firing the same job twice inside its trigger window.
CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL CHECK (job_name IN ('generate', 'review', 'publish_gate')),
  run_date TEXT NOT NULL, -- YYYY-MM-DD in America/New_York
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'error')),
  detail TEXT,
  UNIQUE (job_name, run_date)
);

CREATE INDEX idx_linkedin_posts_status ON linkedin_posts(status);
CREATE INDEX idx_linkedin_posts_scheduled_at ON linkedin_posts(scheduled_at);
CREATE INDEX idx_post_topics_used ON post_topics(used);
