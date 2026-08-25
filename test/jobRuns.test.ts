import { afterEach, describe, expect, it, vi } from "vitest";
import { getJobRunState } from "../src/lib/jobRuns";
import { createFakeD1 } from "./helpers/fakeD1";

function dbWithRun(row: { status: string; started_at: string } | null) {
  return createFakeD1([{ match: /SELECT status, started_at FROM job_runs/, rows: row ? [row] : [] }]).db;
}

afterEach(() => vi.useRealTimers());

describe("getJobRunState", () => {
  it("allows a first attempt when there is no row", async () => {
    expect(await getJobRunState(dbWithRun(null), "review", "2026-07-13")).toEqual({ runnable: true, retry: false });
  });

  it("blocks a job that already succeeded", async () => {
    const state = await getJobRunState(dbWithRun({ status: "ok", started_at: "2026-07-13 12:00:00" }), "review", "2026-07-13");
    expect(state.runnable).toBe(false);
  });

  it("allows a retry after an error", async () => {
    expect(await getJobRunState(dbWithRun({ status: "error", started_at: "2026-07-13 12:00:00" }), "review", "2026-07-13")).toEqual({
      runnable: true,
      retry: true,
    });
  });

  it("does not double-run a job that is genuinely in flight", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-13T12:02:00Z") });
    const state = await getJobRunState(dbWithRun({ status: "running", started_at: "2026-07-13 12:00:00" }), "review", "2026-07-13");
    expect(state.runnable).toBe(false);
  });

  it("reclaims a run abandoned by a dead Worker", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-13T12:30:00Z") });
    expect(await getJobRunState(dbWithRun({ status: "running", started_at: "2026-07-13 12:00:00" }), "review", "2026-07-13")).toEqual({
      runnable: true,
      retry: true,
    });
  });
});
