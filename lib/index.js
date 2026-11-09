/**
 * Host half of dshCostWatchPlugin: folds today's committed assistant usage from
 * the durable Session logs (backfill) and from the live `session/event`
 * firehose, prices each call at DeepSeek's list rate, and serves one
 * owner-authenticated JSON snapshot for the browser ticker.
 *
 * The collector deliberately owns no durable state of its own: a start or a
 * local day rollover rebuilds the day from the canonical logs, so a restart
 * never double-counts persisted calls. Calls committed between the backfill
 * read and the live subscription are buffered and replayed with a per-session
 * sequence cursor.
 *
 * @module dsh-costwatch-plugin
 */
import {
  CN_HOLIDAYS_2026,
  addUsage,
  cacheHitRate,
  costOf,
  emptyTotals,
  isKnownModel,
  isPeakTime,
  localDateLabel,
  localHour,
  nextLocalDay,
  startOfLocalDay,
} from './usage.js';

/** Cordis plugin name. */
export const name = 'dsh-costwatch-plugin';

/** Route the browser ticker polls; `connection.fetch` mounts it below `/api`. */
export const SNAPSHOT_ROUTE = '/api/dsh-costwatch-plugin';

/** Backfill page size; bounds one read's memory without many round trips. */
const READ_PAGE = 500;

/** Trailing events inspected to skip sessions that ended before today. */
const TAIL_WINDOW = 24;

/** Official account-credit endpoint: balance of the API key's account. */
export const BALANCE_URL = 'https://api.deepseek.com/user/balance';

/**
 * Validate the configured credit endpoint. The API key travels with this
 * request, so plain HTTP is accepted only for a loopback proxy.
 * @param {unknown} value - configured URL, or the official default.
 * @returns {string} absolute URL.
 */
function resolveBalanceURL(value) {
  const candidate = typeof value === 'string' && value !== '' ? value : BALANCE_URL;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('dsh-costwatch-plugin: balanceURL must be an absolute URL');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('dsh-costwatch-plugin: balanceURL must use https (http is allowed only for loopback)');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('dsh-costwatch-plugin: balanceURL must not embed credentials');
  }
  return url.href;
}

/**
 * Normalize one `balance_infos` entry without losing the server's decimal
 * precision; the client formats it.
 * @param {unknown} wallet - raw platform wallet.
 * @returns {{currency: string, total: string, granted: string, toppedUp: string} | undefined}
 */
function normalizeWallet(wallet) {
  if (typeof wallet !== 'object' || wallet === null) return undefined;
  const record = /** @type {Record<string, unknown>} */ (wallet);
  const currency = record.currency;
  if (currency !== 'USD' && currency !== 'CNY') return undefined;
  const decimal = (value) =>
    typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? value : '0';
  return {
    currency,
    total: decimal(record.total_balance),
    granted: decimal(record.granted_balance),
    toppedUp: decimal(record.topped_up_balance),
  };
}

/** Required Host services: authenticated Fetch routes and the Session log. */
export const inject = ['connection', 'sessionPersistence'];

/**
 * Extract the priced call a Session event records, when it records one.
 * Assistant messages carry their step's usage; a compaction summary carries
 * the one-shot summarization call's usage and model.
 * @param {object} event - committed Session event.
 * @returns {{usage: object, model: string} | undefined}
 */
function pricedCall(event) {
  if (typeof event !== 'object' || event === null) return undefined;
  if (event.type !== 'assistant/message' && event.type !== 'compaction/summary') return undefined;
  const data = event.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const usage = data.usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const rawModel = event.type === 'assistant/message' ? data.message?.source?.model : data.model;
  return {
    usage,
    model: typeof rawModel === 'string' && rawModel !== '' ? rawModel.slice(0, 200) : 'unknown',
  };
}

/**
 * One day's running usage for the whole Harness home.
 */
export class UsageTicker {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
   * @param {{holidays?: readonly string[], apiKeyEnv?: string, balanceURL?: string, balanceRefreshMs?: number, balanceTimeoutMs?: number}} config - optional overrides.
   */
  constructor(ctx, config) {
    this.ctx = ctx;
    this.holidays = Array.isArray(config?.holidays) ? new Set(config.holidays) : CN_HOLIDAYS_2026;
    const now = Date.now();
    this.dayStart = startOfLocalDay(now);
    this.dayEnd = nextLocalDay(this.dayStart);
    this.totals = emptyTotals();
    this.usd = 0;
    this.hourly = new Array(24).fill(0);
    this.models = Object.create(null);
    this.unpriced = new Set();
    this.maxSeq = new Map();
    this.buffer = [];
    this.ready = false;
    this.loading = false;
    this.updatedAt = now;
    this.generation = 0;
    this.loadController = undefined;
    this.apiKeyEnv =
      typeof config?.apiKeyEnv === 'string' && config.apiKeyEnv !== ''
        ? config.apiKeyEnv
        : 'DEEPSEEK_API_KEY';
    this.balanceURL = resolveBalanceURL(config?.balanceURL);
    const refreshMs = config?.balanceRefreshMs;
    this.balanceRefreshMs = Math.max(
      5_000,
      typeof refreshMs === 'number' && Number.isFinite(refreshMs) ? refreshMs : 60_000,
    );
    const timeoutMs = config?.balanceTimeoutMs;
    this.balanceTimeoutMs = Math.max(
      1_000,
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : 15_000,
    );
    this.credentials = undefined;
    this.balance = { status: 'loading', wallets: [], updatedAt: 0 };
    this.balanceEpoch = 0;
    this.balanceRefreshing = false;
    this.balanceController = undefined;
  }

  /** Subscribe to live usage and start the first backfill. */
  start() {
    this.ctx.on('session/event', (session, event) => {
      if (pricedCall(event) === undefined) return;
      this.ensureDay();
      if (!this.ready) {
        this.buffer.push([session.id, event]);
        return;
      }
      this.acceptLive(session.id, event);
    });
    this.beginLoad();
  }

  /** Abort any in-flight backfill (plugin unload). */
  stop() {
    this.loadController?.abort();
    this.loadController = undefined;
    this.detachCredentials();
  }

  /**
   * Start reading account credit through the credential seam.
   * @param {object} credentials - `ctx.credentials` provider.
   */
  attachCredentials(credentials) {
    this.detachCredentials();
    this.credentials = credentials;
    this.balanceController = new AbortController();
    this.balance = {
      status: 'loading',
      wallets: this.balance.wallets ?? [],
      updatedAt: 0,
    };
    void this.refreshBalance();
  }

  /** Stop reading account credit and forget the resolved key. */
  detachCredentials() {
    this.balanceEpoch += 1;
    this.credentials = undefined;
    this.balanceController?.abort();
    this.balanceController = undefined;
    this.balanceRefreshing = false;
    this.balance = { status: 'no-key', wallets: [], updatedAt: Date.now() };
  }

  /** Refresh credit when its cache has aged out, without blocking the route. */
  ensureBalance() {
    if (this.credentials === undefined) {
      if (this.balance.status !== 'no-key') {
        this.balance = { status: 'no-key', wallets: [], updatedAt: Date.now() };
      }
      return;
    }
    if (!this.balanceRefreshing && Date.now() - this.balance.updatedAt >= this.balanceRefreshMs) {
      void this.refreshBalance();
    }
  }

  /**
   * Resolve the API key and read its account credit from the official
   * `/user/balance` endpoint. One refresh runs at a time; failures keep the
   * last known wallets so the ticker does not blank out.
   */
  async refreshBalance() {
    const credentials = this.credentials;
    const controller = this.balanceController;
    if (credentials === undefined || controller === undefined || this.balanceRefreshing) return;
    this.balanceRefreshing = true;
    const epoch = ++this.balanceEpoch;
    try {
      const resolved = await credentials.resolve(this.apiKeyEnv);
      if (epoch !== this.balanceEpoch) return;
      if (resolved === undefined) {
        this.balance = { status: 'no-key', wallets: [], updatedAt: Date.now() };
        return;
      }
      const response = await fetch(this.balanceURL, {
        headers: {
          authorization: `Bearer ${resolved.value}`,
          accept: 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(this.balanceTimeoutMs),
        ]),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (epoch !== this.balanceEpoch) return;
      const wallets = Array.isArray(body?.balance_infos)
        ? body.balance_infos.map(normalizeWallet).filter((wallet) => wallet !== undefined)
        : [];
      this.balance = {
        status: 'ready',
        isAvailable: body?.is_available === true,
        wallets,
        updatedAt: Date.now(),
      };
    } catch (error) {
      if (epoch !== this.balanceEpoch) return;
      const message = typeof error?.message === 'string' ? error.message : '';
      const reason =
        error?.name === 'TimeoutError'
          ? 'timeout'
          : error?.name === 'AbortError'
            ? 'aborted'
            : /^HTTP \d{3}$/.test(message)
              ? message
              : error?.name === 'SyntaxError'
                ? 'invalid response'
                : error?.name === 'TypeError'
                  ? 'network error'
                  : 'unavailable';
      this.balance = {
        status: 'unavailable',
        isAvailable: this.balance.isAvailable,
        wallets: this.balance.wallets ?? [],
        updatedAt: Date.now(),
        error: reason,
      };
    } finally {
      if (epoch === this.balanceEpoch) this.balanceRefreshing = false;
    }
  }

  /** Move the window to the current local day when midnight has passed. */
  ensureDay() {
    const now = Date.now();
    if (now < this.dayEnd) return;
    this.dayStart = startOfLocalDay(now);
    this.dayEnd = nextLocalDay(this.dayStart);
    this.totals = emptyTotals();
    this.usd = 0;
    this.hourly = new Array(24).fill(0);
    this.models = Object.create(null);
    this.unpriced.clear();
    this.maxSeq.clear();
    this.buffer = [];
    this.updatedAt = now;
    this.beginLoad();
  }

  /** Rebuild today's totals from durable logs, buffering live calls meanwhile. */
  beginLoad() {
    this.loadController?.abort();
    const controller = new AbortController();
    this.loadController = controller;
    const generation = ++this.generation;
    this.ready = false;
    this.loading = true;
    this.load(generation, controller.signal).catch(() => {
      if (controller.signal.aborted || generation !== this.generation) return;
      console.warn('[dsh-costwatch-plugin] backfill failed');
      this.finishLoad(generation);
    });
  }

  /**
   * Read every stored Session, keeping only events from the current day.
   * @param {number} generation - load generation this pass belongs to.
   * @param {AbortSignal} signal - unload or replacement cancellation.
   */
  async load(generation, signal) {
    let sessions = [];
    try {
      sessions = await this.ctx.sessionPersistence.list({ signal });
    } catch {
      if (signal.aborted || generation !== this.generation) return;
      console.warn('[dsh-costwatch-plugin] session list failed');
    }
    for (const snapshot of sessions) {
      if (signal.aborted || generation !== this.generation) return;
      try {
        await this.readSession(snapshot, signal);
      } catch {
        if (signal.aborted || generation !== this.generation) return;
        console.warn('[dsh-costwatch-plugin] a stored session could not be read');
      }
    }
    if (signal.aborted || generation !== this.generation) return;
    this.finishLoad(generation);
  }

  /** Publish the rebuilt totals and replay calls buffered during the read. */
  finishLoad(generation) {
    if (generation !== this.generation) return;
    this.ready = true;
    this.loading = false;
    const buffered = this.buffer;
    this.buffer = [];
    for (const [sessionId, event] of buffered) this.acceptLive(sessionId, event);
    this.updatedAt = Date.now();
  }

  /**
   * Read one stored Session's events from the first one at or after local midnight.
   * @param {{header: {id: string}, eventCount?: number}} snapshot - persistence listing row.
   * @param {AbortSignal} signal - cancellation.
   */
  async readSession(snapshot, signal) {
    const id = snapshot.header.id;
    const count = snapshot.eventCount;
    const handle = await this.ctx.sessionPersistence.open(id, 'read', { signal });
    try {
      let start = 0;
      if (typeof count === 'number' && count > 0) {
        const tailStart = Math.max(0, count - TAIL_WINDOW);
        const tail = await handle.read(tailStart, count - tailStart, { signal });
        const last = tail.events[tail.events.length - 1];
        if (last !== undefined && last.time < this.dayStart) {
          this.maxSeq.set(id, last.seq);
          return;
        }
        start = await this.firstAtOrAfter(handle, count, this.dayStart, signal);
        // Two events of slack covers a tail written slightly out of order.
        start = Math.max(0, start - 2);
      }
      await this.readFrom(handle, id, start, signal);
    } finally {
      await handle.close();
    }
  }

  /**
   * Binary-search the first event whose append time is at or after `threshold`.
   * @returns {Promise<number>} event seq, or `count` when none qualifies.
   */
  async firstAtOrAfter(handle, count, threshold, signal) {
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = (low + high) >> 1;
      const { events } = await handle.read(middle, 1, { signal });
      if (events.length === 0) {
        high = middle;
        break;
      }
      if (events[0].time >= threshold) high = middle;
      else low = middle + 1;
    }
    return low;
  }

  /**
   * Fold one Session's events from `offset` to the end of its log.
   * @param {object} handle - open read handle.
   * @param {string} id - Session id.
   * @param {number} offset - first seq to read.
   * @param {AbortSignal} signal - cancellation.
   */
  async readFrom(handle, id, offset, signal) {
    let cursor = offset;
    for (;;) {
      const { events } = await handle.read(cursor, READ_PAGE, { signal });
      if (events.length === 0) return;
      for (const event of events) {
        if (typeof event.seq === 'number' && Number.isFinite(event.seq)) {
          this.maxSeq.set(id, event.seq);
        }
        if (pricedCall(event) !== undefined) this.fold(event);
      }
      if (events.length < READ_PAGE) return;
      const lastSeq = events[events.length - 1]?.seq;
      if (typeof lastSeq !== 'number' || !Number.isFinite(lastSeq)) return;
      cursor = lastSeq + 1;
    }
  }

  /**
   * Count one live event once, using its Session seq as the cursor.
   * @param {string} sessionId - emitting Session.
   * @param {object} event - committed Session event.
   */
  acceptLive(sessionId, event) {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    if (typeof event?.seq !== 'number' || !Number.isFinite(event.seq)) return;
    const seen = this.maxSeq.get(sessionId) ?? -1;
    if (event.seq <= seen) return;
    this.maxSeq.set(sessionId, event.seq);
    this.fold(event);
  }

  /**
   * Price and add one assistant usage record that falls inside today.
   * @param {object} event - `assistant/message` event.
   */
  fold(event) {
    if (typeof event?.time !== 'number' || !Number.isFinite(event.time)) return;
    if (event.time < this.dayStart || event.time >= this.dayEnd) return;
    const call = pricedCall(event);
    if (call === undefined) return;
    const { usage, model } = call;
    const known = isKnownModel(model);
    if (!known) this.unpriced.add(model);
    const usd = costOf(usage, model, event.time, { holidays: this.holidays });
    addUsage(this.totals, usage);
    this.usd += usd;
    const hour = localHour(event.time);
    if (Number.isInteger(hour) && hour >= 0 && hour <= 23) this.hourly[hour] += usd;
    const entry = (this.models[model] ??= { requests: 0, usd: 0 });
    entry.requests += 1;
    entry.usd += usd;
    this.updatedAt = Date.now();
  }

  /** Build the JSON-safe snapshot the browser polls. */
  snapshot() {
    this.ensureBalance();
    const totals = this.totals;
    const billed = totals.input + totals.cacheRead + totals.cacheWrite;
    return {
      date: localDateLabel(this.dayStart),
      usd: this.usd,
      cacheHit: cacheHitRate(totals),
      requests: totals.requests,
      tokens: {
        input: totals.input,
        cacheRead: totals.cacheRead,
        cacheWrite: totals.cacheWrite,
        output: totals.output,
      },
      billedInput: billed,
      hourlyUsd: this.hourly,
      models: this.models,
      unpricedModels: [...this.unpriced],
      balance: {
        status: this.balance.status,
        isAvailable: this.balance.isAvailable,
        wallets: this.balance.wallets,
        updatedAt: this.balance.updatedAt,
        ...(this.balance.error === undefined ? {} : { error: this.balance.error }),
      },
      peakNow: isPeakTime(Date.now(), this.holidays),
      hour: new Date().getHours(),
      updatedAt: this.updatedAt,
      ready: this.ready,
      loading: this.loading,
    };
  }
}

/**
 * Mount the collector and its authenticated snapshot route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{holidays?: readonly string[], apiKeyEnv?: string, balanceURL?: string, balanceRefreshMs?: number, balanceTimeoutMs?: number}} [config] - optional overrides.
 */
export function apply(ctx, config) {
  const ticker = new UsageTicker(ctx, config);
  ticker.start();
  ctx.effect(() => () => ticker.stop(), 'dsh-costwatch-plugin: collector');
  ctx.inject(['credentials'], (credentialCtx) => {
    ticker.attachCredentials(credentialCtx.credentials);
    credentialCtx.effect(
      () => () => ticker.detachCredentials(),
      'dsh-costwatch-plugin: account credit',
    );
  });
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: SNAPSHOT_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: () => {
          ticker.ensureDay();
          return Promise.resolve(
            Response.json(ticker.snapshot(), {
              headers: {
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff',
              },
            }),
          );
        },
      }),
    'dsh-costwatch-plugin: snapshot route',
  );
}
