/**
 * Pure usage accounting for the ticker: day boundaries, DeepSeek list prices,
 * peak-window detection, cache-hit math, and per-call USD cost.
 *
 * Prices are USD per 1M tokens from DeepSeek's published rate card
 * (https://api-docs.deepseek.com/quick_start/pricing, November 2026):
 *
 *   deepseek-flash  cache hit  0.006 peak / 0.003 off-peak
 *                   cache miss 0.300 peak / 0.150 off-peak
 *                   output     1.200 peak / 0.600 off-peak
 *   deepseek-v4-pro cache hit  0.044 peak / 0.022 off-peak
 *                   cache miss 1.320 peak / 0.660 off-peak
 *                   output     3.960 peak / 1.980 off-peak
 *
 * Peak hours are 01:00-04:00 and 06:00-10:00 UTC on weekdays, excluding
 * Chinese public holidays; all other hours are off-peak. Legacy model ids
 * (`deepseek-v4-flash`, `deepseek-chat`, `deepseek-reasoner`) bill at Flash.
 *
 * @module dsh-costwatch-plugin/usage
 */

const PER_MILLION = 1_000_000;

/** Published DeepSeek Flash rates in USD per token. */
const FLASH = {
  peak: { hit: 0.006 / PER_MILLION, miss: 0.3 / PER_MILLION, out: 1.2 / PER_MILLION },
  off: { hit: 0.003 / PER_MILLION, miss: 0.15 / PER_MILLION, out: 0.6 / PER_MILLION },
};

/** Published DeepSeek V4 Pro rates in USD per token. */
const PRO = {
  peak: { hit: 0.044 / PER_MILLION, miss: 1.32 / PER_MILLION, out: 3.96 / PER_MILLION },
  off: { hit: 0.022 / PER_MILLION, miss: 0.66 / PER_MILLION, out: 1.98 / PER_MILLION },
};

/** Model id to rate card. Unknown ids fall back to Flash (see {@link ratesFor}). */
const RATE_CARDS = new Map([
  ['deepseek-flash', FLASH],
  ['deepseek-v4-flash', FLASH],
  ['deepseek-v4-flash-vision-exp', FLASH],
  ['deepseek-chat', FLASH],
  ['deepseek-reasoner', FLASH],
  ['deepseek-v4-pro', PRO],
]);

/** Expand an inclusive `YYYY-MM-DD` range into its dates. */
function dateRange(start, end) {
  const dates = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor.getTime() <= last.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Chinese public holidays announced for 2026 (Beijing dates), during which
 * DeepSeek bills the off-peak rate all day.
 */
export const CN_HOLIDAYS_2026 = new Set([
  ...dateRange('2026-01-01', '2026-01-03'),
  ...dateRange('2026-02-15', '2026-02-23'),
  ...dateRange('2026-04-04', '2026-04-06'),
  ...dateRange('2026-05-01', '2026-05-05'),
  ...dateRange('2026-06-19', '2026-06-21'),
  ...dateRange('2026-09-25', '2026-09-27'),
  ...dateRange('2026-10-01', '2026-10-07'),
]);

/**
 * The rate card for one model id, or Flash when the id is unknown.
 * @param {string | null | undefined} model - provider model id from the assistant message.
 * @returns {{peak: {hit: number, miss: number, out: number}, off: {hit: number, miss: number, out: number}}}
 */
export function ratesFor(model) {
  return RATE_CARDS.get(model ?? '') ?? FLASH;
}

/** Whether one model id is priced by an explicit entry rather than the Flash fallback. */
export function isKnownModel(model) {
  return RATE_CARDS.has(model ?? '');
}

/** Beijing calendar date (`YYYY-MM-DD`) of an instant. */
function beijingDate(timeMs) {
  return new Date(timeMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Whether DeepSeek charges peak rates at one instant.
 * @param {number} timeMs - Unix epoch milliseconds.
 * @param {ReadonlySet<string>} [holidays] - Beijing dates billed off-peak all day.
 * @returns {boolean}
 */
export function isPeakTime(timeMs, holidays = CN_HOLIDAYS_2026) {
  if (typeof timeMs !== 'number' || !Number.isFinite(timeMs)) return false;
  const date = new Date(timeMs);
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  if (holidays.has(beijingDate(timeMs))) return false;
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/** Local midnight at or before an instant. */
export function startOfLocalDay(timeMs) {
  const date = new Date(timeMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Local midnight after the day that starts at `dayStart`. */
export function nextLocalDay(dayStart) {
  const date = new Date(dayStart);
  date.setDate(date.getDate() + 1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Local `YYYY-MM-DD` label for one day. */
export function localDateLabel(timeMs) {
  const date = new Date(timeMs);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local hour (0-23) of one instant, used for the hourly sparkline. */
export function localHour(timeMs) {
  return new Date(timeMs).getHours();
}

/** Fresh zeroed token totals. */
export function emptyTotals() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 };
}

/** Coerce one provider token count to a non-negative finite number. */
function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Add one provider usage record to running totals.
 * @param {ReturnType<typeof emptyTotals>} totals - mutable totals.
 * @param {{inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number}} usage
 */
export function addUsage(totals, usage) {
  totals.input += tokenCount(usage.inputTokens);
  totals.output += tokenCount(usage.outputTokens);
  totals.cacheRead += tokenCount(usage.cacheReadTokens);
  totals.cacheWrite += tokenCount(usage.cacheWriteTokens);
  totals.requests += 1;
}

/**
 * Exact USD cost of one provider usage record under the list price for its
 * model and the peak window containing the event.
 * @param {{inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number}} usage
 * @param {string | null | undefined} model
 * @param {number} timeMs - event append time.
 * @param {{holidays?: ReadonlySet<string>, fallback?: object}} [options]
 * @returns {number} USD, unrounded.
 */
export function costOf(usage, model, timeMs, options = {}) {
  const card = options.fallback ?? ratesFor(model);
  const rate = isPeakTime(timeMs, options.holidays) ? card.peak : card.off;
  const input = tokenCount(usage.inputTokens);
  const cacheRead = tokenCount(usage.cacheReadTokens);
  const cacheWrite = tokenCount(usage.cacheWriteTokens);
  const output = tokenCount(usage.outputTokens);
  return input * rate.miss + cacheWrite * rate.miss + cacheRead * rate.hit + output * rate.out;
}

/**
 * Share of billed prompt tokens served from cache, in [0, 1].
 * @param {ReturnType<typeof emptyTotals>} totals
 * @returns {number | null} null when no prompt tokens were billed.
 */
export function cacheHitRate(totals) {
  const billed = totals.input + totals.cacheRead + totals.cacheWrite;
  return billed > 0 ? totals.cacheRead / billed : null;
}
