/**
 * Date-range helpers for `traffic` and `business info`.
 *
 * Dates on the command line are `YYYY-MM-DD` in UTC and inclusive. The API takes
 * a half-open RFC 3339 range, so `--to 2026-03-31` is sent as the midnight that
 * ends that day, `2026-04-01T00:00:00Z`, exactly as the dashboard Overview does.
 */
import { usageError } from "./output.js";

const DAY_MS = 86_400_000;
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 3_660;

export interface DayRange {
  /** First day, inclusive, `YYYY-MM-DD`. */
  readonly fromDay: string;
  /** Last day, inclusive, `YYYY-MM-DD`. */
  readonly toDay: string;
  /** Start of the first day, RFC 3339. */
  readonly from: string;
  /** Start of the day after the last day, RFC 3339. */
  readonly to: string;
}

/** Midnight UTC of a `YYYY-MM-DD` string in epoch milliseconds, or a `usage_error`. */
export function parseDay(text: string, flag: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const value = match === null ? Number.NaN : Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(value) || dayString(value) !== text) {
    throw usageError(`${flag} must be a date like 2026-03-31`);
  }
  return value;
}

/** `YYYY-MM-DD` of an epoch-millisecond instant, in UTC. */
export function dayString(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function rfc3339(epochMs: number): string {
  return `${dayString(epochMs)}T00:00:00Z`;
}

function build(fromMs: number, toMs: number): DayRange {
  if (toMs < fromMs) throw usageError("--to must not be before --from");
  const days = (toMs - fromMs) / DAY_MS + 1;
  if (days > MAX_DAYS) throw usageError(`the range may span at most ${MAX_DAYS} days`);
  return { fromDay: dayString(fromMs), toDay: dayString(toMs), from: rfc3339(fromMs), to: rfc3339(toMs + DAY_MS) };
}

/** Today at 00:00 UTC. */
function today(now: Date): number {
  return Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
}

/**
 * The range `traffic` asks for: `--days n` (default 30) ending today, or an
 * explicit `--from` and `--to`. Giving both forms is a `usage_error`.
 */
export function resolveTrafficRange(
  input: { days?: string | undefined; from?: string | undefined; to?: string | undefined },
  now: Date
): DayRange {
  if (input.days !== undefined && (input.from !== undefined || input.to !== undefined)) {
    throw usageError("use either --days or --from and --to, not both");
  }
  if (input.from !== undefined || input.to !== undefined) {
    if (input.from === undefined || input.to === undefined) throw usageError("--from and --to go together");
    return build(parseDay(input.from, "--from"), parseDay(input.to, "--to"));
  }
  let days = DEFAULT_DAYS;
  if (input.days !== undefined) {
    if (!/^\d+$/.test(input.days)) throw usageError(`--days must be a whole number from 1 to ${MAX_DAYS}`);
    days = Number(input.days);
    if (days < 1 || days > MAX_DAYS) throw usageError(`--days must be a whole number from 1 to ${MAX_DAYS}`);
  }
  const end = today(now);
  return build(end - (days - 1) * DAY_MS, end);
}

/**
 * The optional range of `business info`. Neither flag leaves the server's
 * default; `--from` alone runs to today; `--to` alone is a `usage_error`.
 */
export function resolveOptionalRange(input: { from?: string | undefined; to?: string | undefined }, now: Date): DayRange | undefined {
  if (input.from === undefined && input.to === undefined) return undefined;
  if (input.from === undefined) throw usageError("--to needs --from");
  const end = input.to === undefined ? today(now) : parseDay(input.to, "--to");
  return build(parseDay(input.from, "--from"), end);
}

/** Every day of the range, oldest first, as `YYYY-MM-DD`. */
export function eachDay(range: DayRange): string[] {
  const days: string[] = [];
  for (let ms = Date.parse(`${range.fromDay}T00:00:00Z`); ms <= Date.parse(`${range.toDay}T00:00:00Z`); ms += DAY_MS) {
    days.push(dayString(ms));
  }
  return days;
}
