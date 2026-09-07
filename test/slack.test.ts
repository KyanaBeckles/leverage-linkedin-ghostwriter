import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postAlert } from "../src/lib/slack";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const slackJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe("postAlert", () => {
  it("posts the alert text to the given channel", async () => {
    fetchMock.mockResolvedValue(slackJson({ ok: true }));
    await postAlert("t", "C1", "something failed");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ channel: "C1", text: "something failed" });
  });

  it("never throws when Slack rejects the message", async () => {
    fetchMock.mockResolvedValue(slackJson({ ok: false, error: "channel_not_found" }));
    await expect(postAlert("t", "C1", "something failed")).resolves.toBeUndefined();
  });

  it("never throws on a network failure", async () => {
    fetchMock.mockRejectedValue(new Error("connection reset"));
    await expect(postAlert("t", "C1", "something failed")).resolves.toBeUndefined();
  });
});
