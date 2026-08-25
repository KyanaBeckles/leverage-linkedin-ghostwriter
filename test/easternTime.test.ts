import { describe, expect, it } from "vitest";
import { easternDateToUtc, getEasternParts, isInWindow } from "../src/lib/easternTime";

describe("getEasternParts", () => {
  it("reads EDT wall-clock time in summer", () => {
    // 2026-07-15 22:05Z = 18:05 EDT (UTC-4), a Wednesday.
    expect(getEasternParts(new Date("2026-07-15T22:05:00Z"))).toEqual({
      dateStr: "2026-07-15",
      weekday: "Wed",
      hour: 18,
      minute: 5,
    });
  });

  it("reads EST wall-clock time in winter", () => {
    // 2026-01-14 22:05Z = 17:05 EST (UTC-5) — same UTC hour, different ET hour.
    expect(getEasternParts(new Date("2026-01-14T22:05:00Z"))).toMatchObject({ hour: 17, minute: 5 });
  });

  it("rolls the ET date back when UTC has already ticked over", () => {
    // 2026-03-02 02:30Z is still 2026-03-01 21:30 in New York.
    expect(getEasternParts(new Date("2026-03-02T02:30:00Z"))).toEqual({
      dateStr: "2026-03-01",
      weekday: "Sun",
      hour: 21,
      minute: 30,
    });
  });

  it("normalizes the 24:00 hour Intl reports at ET midnight", () => {
    expect(getEasternParts(new Date("2026-07-16T04:00:00Z")).hour).toBe(0);
  });
});

describe("isInWindow", () => {
  const at = (hour: number, minute: number) => ({ dateStr: "2026-07-15", weekday: "Wed" as const, hour, minute });

  it("covers exactly the 15 minutes from the target time", () => {
    expect(isInWindow(at(18, 0), 18, 0)).toBe(true);
    expect(isInWindow(at(18, 14), 18, 0)).toBe(true);
    expect(isInWindow(at(18, 15), 18, 0)).toBe(false);
    expect(isInWindow(at(17, 59), 18, 0)).toBe(false);
  });

  it("extends forward only, for the retry window", () => {
    expect(isInWindow(at(19, 59), 18, 0, 120)).toBe(true);
    expect(isInWindow(at(20, 0), 18, 0, 120)).toBe(false);
    expect(isInWindow(at(17, 30), 18, 0, 120)).toBe(false);
  });
});

describe("easternDateToUtc", () => {
  it("resolves 3:00 PM ET to 19:00Z under EDT", () => {
    expect(easternDateToUtc("2026-07-15", 15, 0).toISOString()).toBe("2026-07-15T19:00:00.000Z");
  });

  it("resolves 3:00 PM ET to 20:00Z under EST", () => {
    expect(easternDateToUtc("2026-01-14", 15, 0).toISOString()).toBe("2026-01-14T20:00:00.000Z");
  });

  it("is correct on both sides of a DST transition", () => {
    // DST starts 2026-03-08; 15:00 on the 7th is EST, on the 8th is EDT.
    expect(easternDateToUtc("2026-03-07", 15, 0).toISOString()).toBe("2026-03-07T20:00:00.000Z");
    expect(easternDateToUtc("2026-03-08", 15, 0).toISOString()).toBe("2026-03-08T19:00:00.000Z");
    // DST ends 2026-11-01.
    expect(easternDateToUtc("2026-10-31", 15, 0).toISOString()).toBe("2026-10-31T19:00:00.000Z");
    expect(easternDateToUtc("2026-11-01", 15, 0).toISOString()).toBe("2026-11-01T20:00:00.000Z");
  });

  it("round-trips back to the requested ET wall-clock time", () => {
    for (const dateStr of ["2026-01-01", "2026-03-08", "2026-06-30", "2026-11-01", "2026-12-31"]) {
      const parts = getEasternParts(easternDateToUtc(dateStr, 15, 0));
      expect({ dateStr: parts.dateStr, hour: parts.hour, minute: parts.minute }).toEqual({ dateStr, hour: 15, minute: 0 });
    }
  });
});
