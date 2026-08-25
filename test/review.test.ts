import { beforeEach, describe, expect, it, vi } from "vitest";
import { runReviewJob } from "../src/jobs/review";
import type { Env } from "../src/env";
import { createFakeD1 } from "./helpers/fakeD1";

const { postReviewMessageMock } = vi.hoisted(() => ({
  postReviewMessageMock: vi.fn(async () => ({ ok: true, ts: "1700000000.000100" })),
}));

vi.mock("../src/lib/slack", () => ({ postReviewMessage: postReviewMessageMock }));

const post = (id: number) => ({ id, draft_text: `draft ${id}`, image_url: null, scheduled_at: "2026-07-13T19:00:00.000Z" });

function envWith(posts: Record<string, unknown>[]) {
  const fake = createFakeD1([
    { match: /SELECT id, draft_text/, rows: posts },
    { match: /UPDATE linkedin_posts/ },
  ]);
  return { env: { DB: fake.db, SLACK_BOT_TOKEN: "t", SLACK_CHANNEL_ID: "C1" } as unknown as Env, fake };
}

beforeEach(() => {
  vi.clearAllMocks();
  postReviewMessageMock.mockResolvedValue({ ok: true, ts: "1700000000.000100" });
});

describe("runReviewJob", () => {
  it("stores the Slack ts the publish gate needs to read the veto", async () => {
    const { env, fake } = envWith([post(1)]);

    await runReviewJob(env, "2026-07-13");

    expect(fake.matching(/status = 'pending_review'/)[0].params).toEqual(["1700000000.000100", 1]);
  });

  it("marks a post failed when Slack won't take it, and still pings the rest", async () => {
    postReviewMessageMock
      .mockResolvedValueOnce({ ok: false, ts: undefined, error: "channel_not_found" } as never)
      .mockResolvedValueOnce({ ok: true, ts: "ts-2" });
    const { env, fake } = envWith([post(1), post(2)]);

    const detail = await runReviewJob(env, "2026-07-13");

    expect(fake.matching(/status = 'failed'/)[0].params).toEqual(["Slack post failed: channel_not_found", 1]);
    expect(fake.matching(/status = 'pending_review'/)[0].params).toEqual(["ts-2", 2]);
    expect(detail).toContain("Posted 1/2");
  });

  it("is a no-op on a day with nothing scheduled", async () => {
    const { env } = envWith([]);
    expect(await runReviewJob(env, "2026-07-14")).toBe("No posts scheduled for 2026-07-14.");
    expect(postReviewMessageMock).not.toHaveBeenCalled();
  });
});
