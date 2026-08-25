import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { dispatch } from "../src/index";
import type { Env } from "../src/env";
import { createFakeD1, type FakeRoute } from "./helpers/fakeD1";

const { generateMock, reviewMock, publishGateMock } = vi.hoisted(() => ({
  generateMock: vi.fn(async () => "generated"),
  reviewMock: vi.fn(async () => "reviewed"),
  publishGateMock: vi.fn(async () => "gated"),
}));

vi.mock("../src/jobs/generate", () => ({ runGenerateJob: generateMock }));
vi.mock("../src/jobs/review", () => ({ runReviewJob: reviewMock }));
vi.mock("../src/jobs/publishGate", () => ({ runPublishGateJob: publishGateMock }));

const NO_PRIOR_RUN: FakeRoute[] = [
  { match: /SELECT status, started_at FROM job_runs/, rows: [] },
  { match: /INSERT INTO job_runs/ },
  { match: /UPDATE job_runs/ },
];

function envWith(routes: FakeRoute[]) {
  const fake = createFakeD1(routes);
  return { env: { DB: fake.db, RUN_SECRET: "s3cret" } as unknown as Env, fake };
}

// 2026-07-12 is a Sunday, 2026-07-13 a Monday, 2026-07-14 a Tuesday (all EDT).
const SUNDAY_1805_ET = new Date("2026-07-12T22:05:00Z");
const MONDAY_0805_ET = new Date("2026-07-13T12:05:00Z");
const MONDAY_1435_ET = new Date("2026-07-13T18:35:00Z");
const TUESDAY_0805_ET = new Date("2026-07-14T12:05:00Z");

beforeEach(() => vi.clearAllMocks());

describe("dispatch", () => {
  it("runs generate in the Sunday evening window only", async () => {
    const { env } = envWith(NO_PRIOR_RUN);
    expect(await dispatch(env, SUNDAY_1805_ET)).toEqual(["generate: ran — generated"]);
    expect(reviewMock).not.toHaveBeenCalled();
    expect(publishGateMock).not.toHaveBeenCalled();
  });

  it("runs review in the MWF morning window and the gate in the afternoon window", async () => {
    const { env } = envWith(NO_PRIOR_RUN);
    expect(await dispatch(env, MONDAY_0805_ET)).toEqual(["review: ran — reviewed"]);
    expect(await dispatch(env, MONDAY_1435_ET)).toEqual(["publish_gate: ran — gated"]);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("does nothing on a non-posting day", async () => {
    const { env } = envWith(NO_PRIOR_RUN);
    expect(await dispatch(env, TUESDAY_0805_ET)).toEqual([]);
    expect(reviewMock).not.toHaveBeenCalled();
  });

  it("still fires a first attempt late in the window, keyed to the ET date", async () => {
    const { env } = envWith(NO_PRIOR_RUN);
    // 2026-07-12 23:50Z is Sunday 19:50 ET — the 18:00 cron firing never
    // happened (Cloudflare skipped it), so this is a first attempt, not a retry.
    expect(await dispatch(env, new Date("2026-07-12T23:50:00Z"))).toEqual(["generate: ran — generated"]);
    expect(generateMock).toHaveBeenCalledWith(env, "2026-07-12");
  });

  it("skips a job that already completed today", async () => {
    const { env } = envWith([
      { match: /SELECT status, started_at FROM job_runs/, rows: [{ status: "ok", started_at: "2026-07-13 12:00:00" }] },
      ...NO_PRIOR_RUN.slice(1),
    ]);
    expect(await dispatch(env, MONDAY_0805_ET)).toEqual([]);
    expect(reviewMock).not.toHaveBeenCalled();
  });

  it("retries a job that errored earlier, without a second job_runs INSERT", async () => {
    const { env, fake } = envWith([
      { match: /SELECT status, started_at FROM job_runs/, rows: [{ status: "error", started_at: "2026-07-13 12:00:00" }] },
      ...NO_PRIOR_RUN.slice(1),
    ]);
    // 09:45 ET — well past the 15-minute window, still inside the 2h retry window.
    expect(await dispatch(env, new Date("2026-07-13T13:45:00Z"))).toEqual(["review: retried — reviewed"]);
    expect(fake.matching(/INSERT INTO job_runs/)).toHaveLength(0);
    expect(fake.matching(/UPDATE job_runs SET status = 'running'/)).toHaveLength(1);
  });

  it("stops retrying once the retry window closes", async () => {
    const { env } = envWith([
      { match: /SELECT status, started_at FROM job_runs/, rows: [{ status: "error", started_at: "2026-07-13 12:00:00" }] },
      ...NO_PRIOR_RUN.slice(1),
    ]);
    // 10:05 ET, 2h05m after the 08:00 target.
    expect(await dispatch(env, new Date("2026-07-13T14:05:00Z"))).toEqual([]);
  });

  it("records a job failure and keeps going instead of throwing", async () => {
    publishGateMock.mockRejectedValueOnce(new Error("Buffer down"));
    const { env, fake } = envWith(NO_PRIOR_RUN);
    expect(await dispatch(env, MONDAY_1435_ET)).toEqual(["publish_gate: failed — Buffer down"]);
    const errorUpdate = fake.matching(/UPDATE job_runs SET status = 'error'/);
    expect(errorUpdate).toHaveLength(1);
    expect(errorUpdate[0].params).toEqual(["Buffer down", "publish_gate", "2026-07-13"]);
  });
});

describe("POST /run", () => {
  const run = (env: Env, headers: HeadersInit = {}) =>
    worker.fetch(new Request("https://worker.example/run", { method: "POST", headers }), env);

  it("rejects a request with no bearer token", async () => {
    const { env } = envWith(NO_PRIOR_RUN);
    const res = await run(env);
    expect(res.status).toBe(401);
    expect(generateMock).not.toHaveBeenCalled();
    expect(reviewMock).not.toHaveBeenCalled();
    expect(publishGateMock).not.toHaveBeenCalled();
  });

  it("rejects a wrong token", async () => {
    const { env } = envWith(NO_PRIOR_RUN);
    expect((await run(env, { Authorization: "Bearer wrong" })).status).toBe(401);
  });

  it("rejects everything when RUN_SECRET is unset rather than opening up", async () => {
    const { env } = envWith(NO_PRIOR_RUN);
    const res = await run({ ...env, RUN_SECRET: "" }, { Authorization: "Bearer " });
    expect(res.status).toBe(401);
  });

  it("dispatches with the right token", async () => {
    const { env } = envWith(NO_PRIOR_RUN);
    const res = await run(env, { Authorization: "Bearer s3cret" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ran: expect.any(Array) });
  });

  it("leaves /health open", async () => {
    const { env } = envWith(NO_PRIOR_RUN);
    const res = await worker.fetch(new Request("https://worker.example/health"), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, et: { weekday: expect.any(String) } });
  });
});
