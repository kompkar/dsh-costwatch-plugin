import assert from 'node:assert/strict';
import test from 'node:test';

import { BALANCE_URL, UsageTicker } from '../lib/index.js';
import { costOf } from '../lib/usage.js';

const usage = (input, output, cacheRead = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: 0,
});

const event = (seq, time, record, model = 'deepseek-v4-flash') => ({
  type: 'assistant/message',
  seq,
  time,
  data: {
    turn: 1,
    step: 1,
    message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model } },
    usage: record,
  },
});

class FakePersistence {
  constructor(sessions) {
    this.sessions = sessions;
  }

  async list() {
    return [...this.sessions].map(([id, events]) => ({
      header: { id },
      eventCount: events.length,
    }));
  }

  async open(id) {
    const events = this.sessions.get(id) ?? [];
    return {
      id,
      async read(offset = 0, length = events.length - offset) {
        return { events: events.slice(offset, offset + length) };
      },
      async close() {},
    };
  }
}

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for the collector');
};

test('backfill folds today, skips older sessions, and live calls dedupe by seq', async () => {
  const now = Date.now();
  const old = event(0, now - 3 * 24 * 60 * 60 * 1000, usage(1_000_000, 0));
  const today = event(0, now, usage(1_000_000, 0));
  const sessions = new Map([
    ['today', [today]],
    ['old', [old]],
    ['live', []],
  ]);
  let handler;
  const ctx = {
    on(name, listener) {
      if (name === 'session/event') handler = listener;
    },
    sessionPersistence: new FakePersistence(sessions),
  };
  const ticker = new UsageTicker(ctx, {});
  ticker.start();
  await waitFor(() => ticker.ready);

  const first = ticker.snapshot();
  assert.equal(first.requests, 1);
  assert.equal(first.cacheHit, 0);
  assert.equal(first.usd, costOf(usage(1_000_000, 0), 'deepseek-v4-flash', now));

  // A replayed seq from the backfill is not counted twice.
  handler({ id: 'today' }, today);
  assert.equal(ticker.snapshot().requests, 1);

  // A new seq on an existing session is counted once.
  handler({ id: 'today' }, event(1, now, usage(0, 0, 1_000_000)));
  assert.equal(ticker.snapshot().requests, 2);
  assert.equal(ticker.snapshot().cacheHit, 0.5);

  // A session that had no events yet starts at seq 0.
  handler({ id: 'live' }, event(0, now, usage(1_000_000, 0)));
  assert.equal(ticker.snapshot().requests, 3);

  // A late event from an earlier day advances the cursor but adds nothing.
  handler({ id: 'live' }, event(1, now - 2 * 24 * 60 * 60 * 1000, usage(1_000_000, 0)));
  assert.equal(ticker.snapshot().requests, 3);

  ticker.stop();
});

test('compaction summarization calls count as priced usage', async () => {
  const now = Date.now();
  const summary = {
    type: 'compaction/summary',
    seq: 0,
    time: now,
    data: { model: 'deepseek-v4-flash', provider: 'deepseek-official', usage: usage(1_000_000, 0) },
  };
  const sessions = new Map([['compacted', [summary]]]);
  const ctx = { on() {}, sessionPersistence: new FakePersistence(sessions) };
  const ticker = new UsageTicker(ctx, {});
  ticker.start();
  await waitFor(() => ticker.ready);
  assert.equal(ticker.snapshot().requests, 1);
  assert.equal(ticker.snapshot().usd, costOf(usage(1_000_000, 0), 'deepseek-v4-flash', now));
  ticker.stop();
});

test('credit balance is read from /user/balance and survives a failed refresh', async () => {
  const originalFetch = globalThis.fetch;
  const ctx = { on() {}, sessionPersistence: new FakePersistence(new Map()) };
  const ticker = new UsageTicker(ctx, {});
  ticker.start();
  let requested;
  globalThis.fetch = async (url, options) => {
    requested = { url: String(url), auth: options?.headers?.authorization };
    return {
      ok: true,
      json: async () => ({
        is_available: true,
        balance_infos: [
          {
            currency: 'USD',
            total_balance: '12.34',
            granted_balance: '2.00',
            topped_up_balance: '10.34',
          },
        ],
      }),
    };
  };
  try {
    ticker.attachCredentials({ resolve: async () => ({ value: 'test-key', source: 'test' }) });
    await waitFor(() => ticker.snapshot().balance.status === 'ready');
    const ready = ticker.snapshot().balance;
    assert.equal(requested.url, BALANCE_URL);
    assert.equal(requested.auth, 'Bearer test-key');
    assert.equal(ready.isAvailable, true);
    assert.equal(ready.wallets[0].total, '12.34');
    assert.equal(ready.wallets[0].granted, '2.00');

    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    ticker.balance.updatedAt = 0;
    await waitFor(() => ticker.snapshot().balance.status === 'unavailable');
    const failed = ticker.snapshot().balance;
    assert.equal(failed.wallets[0].total, '12.34');
    assert.equal(failed.error, 'network error');

    let resolved = false;
    ticker.attachCredentials({
      resolve: async () => {
        resolved = true;
        return undefined;
      },
    });
    await waitFor(() => resolved && ticker.snapshot().balance.status === 'no-key');
  } finally {
    ticker.stop();
    globalThis.fetch = originalFetch;
  }
});

test('a cleartext non-loopback balance URL is refused', () => {
  assert.throws(
    () => new UsageTicker({}, { balanceURL: 'http://example.com/user/balance' }),
    /https/,
  );
  assert.doesNotThrow(
    () => new UsageTicker({}, { balanceURL: 'http://127.0.0.1:8080/user/balance' }),
  );
});

test('a day rollover rebuilds from the new local day', async () => {
  const now = Date.now();
  const sessions = new Map([['today', [event(0, now, usage(1_000_000, 0))]]]);
  const ctx = {
    on() {},
    sessionPersistence: new FakePersistence(sessions),
  };
  const ticker = new UsageTicker(ctx, {});
  ticker.start();
  await waitFor(() => ticker.ready);
  assert.equal(ticker.snapshot().requests, 1);

  // Force the window closed, then let the next read roll it over.
  ticker.dayEnd = Date.now() - 1;
  ticker.ensureDay();
  assert.equal(ticker.snapshot().ready, false);
  await waitFor(() => ticker.ready);
  const rebuilt = ticker.snapshot();
  assert.equal(rebuilt.requests, 1);
  assert.equal(rebuilt.usd, costOf(usage(1_000_000, 0), 'deepseek-v4-flash', now));
  ticker.stop();
});
