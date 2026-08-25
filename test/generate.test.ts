import { beforeEach, describe, expect, it, vi } from "vitest";
import { runGenerateJob } from "../src/jobs/generate";
import type { Env } from "../src/env";
import { createFakeD1, type FakeRoute } from "./helpers/fakeD1";

type ClaudeCall = (args: import("../src/lib/claude").ClaudeGenerateArgs) => Promise<{ text: string; tokensUsed: number }>;
type AlertCall = (token: string, channel: string, text: string, threadTs?: string) => Promise<void>;

const { claudeMock, alertMock } = vi.hoisted(() => ({
  claudeMock: vi.fn<ClaudeCall>(),
  alertMock: vi.fn<AlertCall>(),
}));

vi.mock("../src/lib/claude", () => ({ generateWithClaude: claudeMock }));
vi.mock("../src/lib/slack", () => ({ postAlert: alertMock }));

const VOICE = {
  id: 1,
  tone: "warm",
  sentence_rhythm: "punchy",
  structural_patterns: JSON.stringify(["opener"]),
  signature_phrases: JSON.stringify(["let's dig in"]),
  avoid_list: JSON.stringify(["hustle"]),
  example_excerpts: JSON.stringify(["one", "two", "three", "four"]),
};

const topic = (id: number, overrides: Partial<Record<string, unknown>> = {}) => ({
  id,
  topic: `topic ${id}`,
  source_context: null,
  mode: "aphorism",
  audience_tag: "public_sector",
  priority: 10 - id,
  ...overrides,
});

function envWith(topics: Record<string, unknown>[], extra: FakeRoute[] = []) {
  const fake = createFakeD1([
    { match: /FROM voice_profiles/, rows: [VOICE] },
    { match: /FROM post_topics WHERE used = 0/, rows: topics },
    { match: /INSERT INTO linkedin_posts/, meta: { last_row_id: 7 } },
    { match: /UPDATE post_topics SET used = 1/ },
    { match: /INSERT INTO post_generation_logs/ },
    ...extra,
  ]);
  return { env: { DB: fake.db, ANTHROPIC_API_KEY: "k", SLACK_BOT_TOKEN: "t", SLACK_CHANNEL_ID: "C1" } as unknown as Env, fake };
}

beforeEach(() => {
  vi.clearAllMocks();
  claudeMock.mockResolvedValue({ text: "a draft", tokensUsed: 120 });
  alertMock.mockResolvedValue(undefined);
});

describe("runGenerateJob", () => {
  it("schedules three drafts for the coming Mon/Wed/Fri at 3:00 PM ET", async () => {
    const { env, fake } = envWith([topic(1), topic(2, { mode: "event_recap" }), topic(3, { mode: "curated_series" })]);
    const detail = await runGenerateJob(env, "2026-07-12"); // a Sunday

    expect(detail).toContain("Generated 3 draft(s)");
    const scheduledAt = fake.matching(/INSERT INTO linkedin_posts/).map((c) => c.params[3]);
    expect(scheduledAt).toEqual([
      "2026-07-13T19:00:00.000Z", // Mon 15:00 EDT
      "2026-07-15T19:00:00.000Z", // Wed
      "2026-07-17T19:00:00.000Z", // Fri
    ]);
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("keeps the surviving drafts when one topic fails to draft", async () => {
    claudeMock
      .mockResolvedValueOnce({ text: "first", tokensUsed: 1 })
      .mockRejectedValueOnce(new Error("Claude 529"))
      .mockResolvedValueOnce({ text: "third", tokensUsed: 1 });
    const { env, fake } = envWith([topic(1), topic(2, { mode: "event_recap" }), topic(3, { mode: "curated_series" })]);

    const detail = await runGenerateJob(env, "2026-07-12");

    expect(fake.matching(/INSERT INTO linkedin_posts/)).toHaveLength(2);
    expect(detail).toContain("Failed: 2026-07-15 (topic 2): Claude 529");
    // The Wednesday slot is empty, and the Friday draft keeps its own date
    // rather than sliding into Wednesday's.
    expect(fake.matching(/INSERT INTO linkedin_posts/).map((c) => c.params[3])).toEqual([
      "2026-07-13T19:00:00.000Z",
      "2026-07-17T19:00:00.000Z",
    ]);
    expect(alertMock.mock.calls[0][2]).toContain("generated 2/3 drafts");
  });

  it("leaves a topic unused when its draft fails, so it comes back next week", async () => {
    claudeMock.mockRejectedValue(new Error("Claude 529"));
    const { env, fake } = envWith([topic(1)]);

    await runGenerateJob(env, "2026-07-12");

    expect(fake.matching(/UPDATE post_topics SET used = 1/)).toHaveLength(0);
  });

  it("rejects an empty draft rather than scheduling a blank post", async () => {
    claudeMock.mockResolvedValue({ text: "   ", tokensUsed: 1 });
    const { env, fake } = envWith([topic(1)]);

    const detail = await runGenerateJob(env, "2026-07-12");

    expect(fake.matching(/INSERT INTO linkedin_posts/)).toHaveLength(0);
    expect(detail).toContain("Claude returned an empty draft");
  });

  it("rejects a draft over LinkedIn's character limit", async () => {
    claudeMock.mockResolvedValue({ text: "x".repeat(3001), tokensUsed: 1 });
    const { env, fake } = envWith([topic(1)]);

    const detail = await runGenerateJob(env, "2026-07-12");

    expect(fake.matching(/INSERT INTO linkedin_posts/)).toHaveLength(0);
    expect(detail).toContain("over LinkedIn's 3000-char limit");
  });

  it("alerts Slack instead of silently posting nothing when the queue is empty", async () => {
    const { env } = envWith([]);

    const detail = await runGenerateJob(env, "2026-07-12");

    expect(detail).toContain("No unused topics remaining");
    expect(alertMock.mock.calls[0][2]).toContain("no posts will go out this week");
  });

  it("alerts when the queue can only fill part of the week", async () => {
    const { env } = envWith([topic(1)]);

    await runGenerateJob(env, "2026-07-12");

    expect(alertMock.mock.calls[0][2]).toContain("only 1 unused topic(s) left in the queue");
  });

  it("allows at most one product-forward topic per batch", async () => {
    const { env, fake } = envWith([
      topic(1, { audience_tag: "product" }),
      topic(2, { audience_tag: "product", mode: "event_recap" }),
      topic(3, { mode: "curated_series" }),
      topic(4, { mode: "event_recap" }),
    ]);

    await runGenerateJob(env, "2026-07-12");

    expect(fake.matching(/UPDATE post_topics SET used = 1/).map((c) => c.params[0])).toEqual([1, 3, 4]);
  });
});
