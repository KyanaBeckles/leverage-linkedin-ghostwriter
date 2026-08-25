import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postReviewMessage, wasVetoed } from "../src/lib/slack";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const slackJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe("wasVetoed", () => {
  it("reports a veto reaction", async () => {
    fetchMock.mockResolvedValue(slackJson({ ok: true, message: { reactions: [{ name: "no_entry_sign", count: 1 }] } }));
    expect(await wasVetoed("t", "C1", "1700000000.000100")).toBe(true);
  });

  it("ignores other reactions", async () => {
    fetchMock.mockResolvedValue(slackJson({ ok: true, message: { reactions: [{ name: "heart", count: 3 }] } }));
    expect(await wasVetoed("t", "C1", "1700000000.000100")).toBe(false);
  });

  it("retries a transient Slack error", async () => {
    fetchMock
      .mockResolvedValueOnce(slackJson({ ok: false, error: "ratelimited" }))
      .mockResolvedValueOnce(slackJson({ ok: true, message: { reactions: [] } }));
    expect(await wasVetoed("t", "C1", "1700000000.000100", 2)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws rather than assuming 'not vetoed' when Slack stays broken", async () => {
    fetchMock.mockResolvedValue(slackJson({ ok: false, error: "ratelimited" }));
    await expect(wasVetoed("t", "C1", "1700000000.000100", 2)).rejects.toThrow(/ratelimited/);
  });

  it("gives up immediately on an error a retry can't fix", async () => {
    fetchMock.mockResolvedValue(slackJson({ ok: false, error: "invalid_auth" }));
    await expect(wasVetoed("t", "C1", "1700000000.000100", 3)).rejects.toThrow(/invalid_auth/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on a network failure too", async () => {
    fetchMock.mockRejectedValue(new Error("connection reset"));
    await expect(wasVetoed("t", "C1", "1700000000.000100", 1)).rejects.toThrow(/connection reset/);
  });
});

describe("postReviewMessage", () => {
  it("returns the message ts the publish gate needs", async () => {
    fetchMock.mockResolvedValue(slackJson({ ok: true, ts: "1700000000.000100" }));
    expect(await postReviewMessage("t", "C1", "draft")).toEqual({ ok: true, ts: "1700000000.000100", error: undefined });
  });

  it("reports a network failure instead of throwing into the review loop", async () => {
    fetchMock.mockRejectedValue(new Error("connection reset"));
    expect(await postReviewMessage("t", "C1", "draft")).toEqual({ ok: false, error: "connection reset" });
  });

  it("includes the image block only when there is an image", async () => {
    fetchMock.mockResolvedValue(slackJson({ ok: true, ts: "1" }));
    await postReviewMessage("t", "C1", "draft", "https://img.example/card.png");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.blocks.map((b: { type: string }) => b.type)).toEqual(["section", "image", "context"]);
  });
});
