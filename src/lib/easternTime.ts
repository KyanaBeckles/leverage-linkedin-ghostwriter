// Cloudflare cron is UTC-only with no DST awareness (see cron-triggers
// gotchas). Rather than hand-maintaining two seasonal cron expressions, the
// Worker fires every 15 minutes year-round and asks Intl for the *actual*
// current America/New_York wall-clock time, which the IANA tz database keeps
// correct across DST transitions automatically.

export interface EasternParts {
  dateStr: string; // YYYY-MM-DD, for job_runs.run_date
  weekday: "Sun" | "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat";
  hour: number;
  minute: number;
}

const FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function getEasternParts(now: Date = new Date()): EasternParts {
  const parts = Object.fromEntries(FORMATTER.formatToParts(now).map((p) => [p.type, p.value]));
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday as EasternParts["weekday"],
    hour: parts.hour === "24" ? 0 : Number(parts.hour),
    minute: Number(parts.minute),
  };
}

// True when `now` falls within a `windowMinutes`-wide window starting at
// targetHour:targetMinute ET. Since the trigger fires every 15 minutes, a
// 15-minute window guarantees exactly one firing hits it.
export function isInWindow(parts: EasternParts, targetHour: number, targetMinute: number, windowMinutes = 15): boolean {
  const nowTotal = parts.hour * 60 + parts.minute;
  const targetTotal = targetHour * 60 + targetMinute;
  return nowTotal >= targetTotal && nowTotal < targetTotal + windowMinutes;
}

// Converts a target ET wall-clock time on `dateStr` into the correct UTC
// Date, by round-tripping through Intl so the DST offset is always right.
export function easternDateToUtc(dateStr: string, hour: number, minute: number): Date {
  // Start from a naive UTC guess, then correct by however far Intl says
  // that guess actually landed from the intended ET wall-clock time.
  const [y, m, d] = dateStr.split("-").map(Number);
  let guess = new Date(Date.UTC(y, m - 1, d, hour, minute));
  for (let i = 0; i < 2; i++) {
    const actual = getEasternParts(guess);
    const actualTotal = actual.hour * 60 + actual.minute;
    const targetTotal = hour * 60 + minute;
    const diffMinutes = targetTotal - actualTotal;
    if (diffMinutes === 0 && actual.dateStr === dateStr) break;
    guess = new Date(guess.getTime() + diffMinutes * 60_000);
  }
  return guess;
}
