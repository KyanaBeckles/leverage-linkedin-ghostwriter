import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPublishGateJob } from "../src/jobs/publishGate";
import type { Env } from "../src/env";
import { createFakeD1, type FakeRoute } from "./helpers/fakeD1";

type AlertCall = (token: string, channel: string, text: string, threadTs?: string) => Promise<void>;
type BufferCall = (args: import("../src/lib/buffer").SchedulePostArgs) => Promise<string>;

const { postAlertMock, bufferMock } = vi.hoisted(() => ({
  postAlertMock: vi.fn<AlertCall>(),
  bufferMock: vi.fn<BufferCall>(),
}));

vi.mock("../src/lib/slack", () => ({ postAlert: postAlertMock }));
vi.mock("../src/lib/buffer", () => ({ schedulePostViaBuffer: bufferMock }));

const SCHEDULED_POST = {
  id: 42,
  draft_text: "the draft",
  edited_text: null,
  image_url: null,
  is_text_card: 0,
  scheduled_at: "2026-07-13T19:00:00.000Z",
  facebook_status: null,
};

function envWith(scheduled: Record<string, unknown>[]): { env: Env; fake: ReturnType<typeof createFakeD1> } {
  const routes: FakeRoute[] = [
    { match: /status = 'scheduled'/, rows: scheduled },
    { match: /UPDATE linkedin_posts/ },
  ];
  const fake = createFakeD1(routes);
  return {
    env: {
      DB: fake.db,
      SLACK_BOT_TOKEN: "t",
      SLACK_CHANNEL_ID: "C1",
      BUFFER_API_KEY: "b",
      BUFFER_CHANNEL_ID: "ch",
      BUFFER_FACEBOOK_CHANNEL_ID: "fb-ch",
    } as unknown as Env,
    fake,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  postAlertMock.mockResolvedValue(undefined);
  bufferMock.mockResolvedValue("buffer-post-1");
  vi.useFakeTimers({ now: new Date("2026-07-13T18:35:00Z") }); // 14:35 ET
});

afterEach(() => vi.useRealTimers());

describe("runPublishGateJob", () => {
  it("publishes a post scheduled for today directly, no review/veto step", async () => {
    const { env, fake } = envWith([SCHEDULED_POST]);

    const detail = await runPublishGateJob(env, "2026-07-13");

    expect(bufferMock.mock.calls[0][0]).toMatchObject({ text: "the draft", dueAt: new Date("2026-07-13T19:00:00.000Z") });
    expect(fake.matching(/status = 'posted'/)[0].params).toEqual(["buffer-post-1", 42]);
    expect(detail).toContain("Posted 1");
  });

  it("returns early when nothing is scheduled for today", async () => {
    const { env } = envWith([]);

    const detail = await runPublishGateJob(env, "2026-07-13");

    expect(bufferMock).not.toHaveBeenCalled();
    expect(detail).toContain("No posts scheduled for 2026-07-13");
  });

  it("pushes dueAt into the future when the gate itself runs late", async () => {
    vi.setSystemTime(new Date("2026-07-13T19:20:00Z")); // 15:20 ET, past the slot
    const { env } = envWith([SCHEDULED_POST]);

    await runPublishGateJob(env, "2026-07-13");

    // Buffer rejects a customScheduled post dated in the past.
    expect(bufferMock.mock.calls[0][0].dueAt).toEqual(new Date("2026-07-13T19:25:00Z"));
  });

  it("marks a Buffer failure on the post and alerts the channel", async () => {
    bufferMock.mockImplementation(async (args) => {
      if (args.channelId === "ch") throw new Error("channel disconnected");
      return "buffer-post-1";
    });
    const { env, fake } = envWith([SCHEDULED_POST]);

    const detail = await runPublishGateJob(env, "2026-07-13");

    expect(fake.matching(/status = 'failed'/)[0].params).toEqual(["channel disconnected", 42]);
    expect(postAlertMock.mock.calls[0][2]).toContain("failed to publish to Buffer");
    expect(detail).toContain("failed 1");
  });

  it("prefers an edited draft over the generated one", async () => {
    const { env } = envWith([{ ...SCHEDULED_POST, edited_text: "Kyana's rewrite" }]);

    await runPublishGateJob(env, "2026-07-13");

    expect(bufferMock.mock.calls[0][0].text).toBe("Kyana's rewrite");
  });

  it("cross-posts the same approved text to Facebook using its own channel", async () => {
    const { env, fake } = envWith([SCHEDULED_POST]);

    const detail = await runPublishGateJob(env, "2026-07-13");

    expect(bufferMock).toHaveBeenCalledTimes(2);
    expect(bufferMock.mock.calls[1][0]).toMatchObject({ channelId: "fb-ch", text: "the draft" });
    expect(fake.matching(/facebook_status = 'posted'/)[0].params).toEqual(["buffer-post-1", 42]);
    expect(detail).toContain("Facebook: posted 1, failed 0");
  });

  it("marks a Facebook failure independently, without blocking the LinkedIn post", async () => {
    bufferMock.mockImplementation(async (args) => {
      if (args.channelId === "fb-ch") throw new Error("facebook channel disconnected");
      return "buffer-post-1";
    });
    const { env, fake } = envWith([SCHEDULED_POST]);

    const detail = await runPublishGateJob(env, "2026-07-13");

    expect(fake.matching(/status = 'posted'/)[0].params).toEqual(["buffer-post-1", 42]);
    expect(fake.matching(/facebook_status = 'failed'/)[0].params).toEqual(["facebook channel disconnected", 42]);
    expect(postAlertMock.mock.calls[0][2]).toContain("failed to cross-post to Facebook");
    expect(detail).toContain("Posted 1");
    expect(detail).toContain("Facebook: posted 0, failed 1");
  });

  it("sends an empty caption when a text-card image exists, so the card isn't duplicated as text", async () => {
    const { env } = envWith([{ ...SCHEDULED_POST, image_url: "https://res.cloudinary.com/demo/card.png", is_text_card: 1 }]);

    await runPublishGateJob(env, "2026-07-13");

    expect(bufferMock.mock.calls[0][0]).toMatchObject({ text: "", imageUrl: "https://res.cloudinary.com/demo/card.png" });
    expect(bufferMock.mock.calls[1][0]).toMatchObject({ text: "", imageUrl: "https://res.cloudinary.com/demo/card.png" });
  });

  it("still sends the real caption when a photo is attached (not a text-card)", async () => {
    const { env } = envWith([{ ...SCHEDULED_POST, image_url: "https://res.cloudinary.com/demo/photo.jpg", is_text_card: 0 }]);

    await runPublishGateJob(env, "2026-07-13");

    expect(bufferMock.mock.calls[0][0]).toMatchObject({ text: "the draft", imageUrl: "https://res.cloudinary.com/demo/photo.jpg" });
  });

  it("skips a post already cross-posted to Facebook, on a manual retry", async () => {
    const { env, fake } = envWith([{ ...SCHEDULED_POST, facebook_status: "posted" }]);

    await runPublishGateJob(env, "2026-07-13");

    expect(bufferMock).toHaveBeenCalledTimes(1); // LinkedIn only
    expect(fake.matching(/UPDATE linkedin_posts SET facebook_status/)).toHaveLength(0);
  });
});
