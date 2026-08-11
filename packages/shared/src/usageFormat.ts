// @effect-diagnostics globalDate:off -- Usage windows are calendar days in the viewer's zone, derived from wall-clock "now" via Intl.
/**
 * Display formatting for the usage page.
 *
 * @module usageFormat
 */
import { UsageDay, type UsageSummaryInput } from "@t3tools/contracts";

const CURRENCY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INTEGER = new Intl.NumberFormat("en-US");

const TOKEN_UNIT_PROMOTION_THRESHOLD = 999.5;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const CALENDAR_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function formatUsd(value: number): string {
  return CURRENCY.format(value);
}

export function formatCount(value: number): string {
  return INTEGER.format(Math.round(value));
}

/**
 * Compacts a token count to three significant figures with a unit suffix, so
 * columns of numbers line up at a glance (`19.9B`, `76.7M`, `804K`).
 */
export function formatTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= TOKEN_UNIT_PROMOTION_THRESHOLD * 1e9) return `${trim(value / 1e12)}T`;
  if (abs >= TOKEN_UNIT_PROMOTION_THRESHOLD * 1e6) return `${trim(value / 1e9)}B`;
  if (abs >= TOKEN_UNIT_PROMOTION_THRESHOLD * 1e3) return `${trim(value / 1e6)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3)}K`;
  return INTEGER.format(Math.round(value));
}

function trim(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "");
}

export function formatPercent(share: number, digits = 1): string {
  return `${(share * 100).toFixed(digits)}%`;
}

function parseCalendarDay(day: string): number | null {
  const match = CALENDAR_DAY_RE.exec(day);
  if (match === null) return null;
  const [, yearText = "", monthText = "", dayText = ""] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const dayOfMonth = Number(dayText);
  const timestamp = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(timestamp)) return null;
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== dayOfMonth
  ) {
    return null;
  }
  return timestamp;
}

/** `2026-08-07` to `Aug 7`. */
export function formatDayShort(day: string): string {
  const timestamp = parseCalendarDay(day);
  if (timestamp === null) return day;
  const parsed = new Date(timestamp);
  return `${MONTHS[parsed.getUTCMonth()] ?? ""} ${parsed.getUTCDate()}`;
}

/** Inclusive day list between two `YYYY-MM-DD` bounds. */
export function enumerateDays(sinceDay: string, untilDay: string): readonly string[] {
  const days: string[] = [];
  const start = parseCalendarDay(sinceDay);
  const end = parseCalendarDay(untilDay);
  if (start === null || end === null || end < start) return days;

  for (let cursor = start; cursor <= end; cursor += 86_400_000) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * The window the page requests, expressed in the viewer's own time zone so days
 * line up with what they actually experienced.
 */
export function makeWindow(days: number, now = new Date()): UsageSummaryInput {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const untilDay = format.format(now);
  // Subtracting fixed milliseconds from `now` lands on the wrong calendar day
  // around a DST transition. Only "today" needs the zone; the window start is
  // pure calendar arithmetic on that day, done in UTC where days are uniform.
  const [year = 0, month = 1, dayOfMonth = 1] = untilDay
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const start = new Date(Date.UTC(year, month - 1, dayOfMonth - (days - 1)));
  return {
    sinceDay: UsageDay.make(start.toISOString().slice(0, 10)),
    untilDay: UsageDay.make(untilDay),
    timeZone,
  };
}
