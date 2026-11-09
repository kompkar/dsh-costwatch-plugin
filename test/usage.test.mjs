import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addUsage,
  cacheHitRate,
  costOf,
  emptyTotals,
  isKnownModel,
  isPeakTime,
  localDateLabel,
  nextLocalDay,
  startOfLocalDay,
} from '../lib/usage.js';

const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: cacheWrite,
});

const close = (actual, expected, epsilon = 1e-12) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} !== ${expected}`);
};

test('cache hit rate divides cache reads by all billed prompt buckets', () => {
  const totals = emptyTotals();
  addUsage(totals, usage(1_000, 50, 3_000, 1_000));
  assert.equal(totals.input, 1_000);
  assert.equal(totals.cacheRead, 3_000);
  assert.equal(totals.cacheWrite, 1_000);
  assert.equal(totals.output, 50);
  assert.equal(totals.requests, 1);
  assert.equal(cacheHitRate(totals), 3_000 / 5_000);
  assert.equal(cacheHitRate(emptyTotals()), null);
});

test('Flash list prices apply per token bucket at off-peak', () => {
  const time = Date.UTC(2026, 10, 9, 20, 0); // Monday 20:00 UTC, off-peak
  close(costOf(usage(1_000_000, 0), 'deepseek-v4-flash', time), 0.15);
  close(costOf(usage(0, 0, 1_000_000, 0), 'deepseek-v4-flash', time), 0.003);
  close(costOf(usage(0, 1_000_000), 'deepseek-v4-flash', time), 0.6);
  // Cache writes are input written to cache; bill them at the miss rate.
  close(costOf(usage(0, 0, 0, 1_000_000), 'deepseek-v4-flash', time), 0.15);
});

test('peak windows double every Flash bucket', () => {
  const peak = Date.UTC(2026, 10, 9, 2, 0); // Monday 02:00 UTC
  close(costOf(usage(1_000_000, 0), 'deepseek-flash', peak), 0.3);
  close(costOf(usage(0, 0, 1_000_000, 0), 'deepseek-flash', peak), 0.006);
  close(costOf(usage(0, 1_000_000), 'deepseek-flash', peak), 1.2);
});

test('peak windows are the two published UTC weekday bands', () => {
  const at = (hour, minute = 0) => Date.UTC(2026, 10, 9, hour, minute); // Monday
  assert.equal(isPeakTime(at(0, 59)), false);
  assert.equal(isPeakTime(at(1, 0)), true);
  assert.equal(isPeakTime(at(3, 59)), true);
  assert.equal(isPeakTime(at(4, 0)), false);
  assert.equal(isPeakTime(at(5, 59)), false);
  assert.equal(isPeakTime(at(6, 0)), true);
  assert.equal(isPeakTime(at(9, 59)), true);
  assert.equal(isPeakTime(at(10, 0)), false);
});

test('weekends and Chinese public holidays stay off-peak', () => {
  assert.equal(isPeakTime(Date.UTC(2026, 10, 7, 2, 0)), false); // Saturday
  assert.equal(isPeakTime(Date.UTC(2026, 10, 8, 2, 0)), false); // Sunday
  assert.equal(isPeakTime(Date.UTC(2026, 1, 16, 2, 0)), false); // CNY holiday Monday
});

test('pro rates and legacy Flash aliases resolve to their cards', () => {
  const time = Date.UTC(2026, 10, 9, 2, 0);
  close(costOf(usage(1_000_000, 0), 'deepseek-v4-pro', time), 1.32);
  close(costOf(usage(1_000_000, 0), 'deepseek-chat', time), 0.3);
  assert.equal(isKnownModel('deepseek-v4-flash'), true);
  assert.equal(isKnownModel('deepseek-v4-pro'), true);
  assert.equal(isKnownModel('some-future-model'), false);
});

test('an unknown model is billed at the Flash fallback', () => {
  const time = Date.UTC(2026, 10, 9, 20, 0);
  close(costOf(usage(1_000_000, 0), 'some-future-model', time), 0.15);
});

test('a representative day costs the expected amount', () => {
  const totals = emptyTotals();
  addUsage(totals, usage(120_000, 30_000, 4_000_000, 500_000));
  const time = Date.UTC(2026, 10, 9, 20, 27); // off-peak
  const usd = costOf(
    usage(totals.input, totals.output, totals.cacheRead, totals.cacheWrite),
    'deepseek-v4-flash',
    time,
  );
  close(usd, 0.123, 1e-12);
  const rate = cacheHitRate(totals);
  assert.ok(rate > 0.865 && rate < 0.866, `unexpected cache hit rate ${rate}`);
});

test('local day bounds are consecutive local midnights', () => {
  const start = startOfLocalDay(Date.UTC(2026, 10, 9, 20, 27));
  assert.equal(new Date(start).getHours(), 0);
  assert.equal(localDateLabel(start), '2026-11-09');
  const end = nextLocalDay(start);
  assert.equal(new Date(end).getHours(), 0);
  assert.equal(localDateLabel(end), '2026-11-10');
  assert.ok(end - start >= 23 * 60 * 60 * 1000);
  assert.ok(end - start <= 25 * 60 * 60 * 1000);
});
