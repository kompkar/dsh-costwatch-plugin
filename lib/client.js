/**
 * Browser half of dshCostWatchPlugin: a slim always-on `shell.bottom` bar that polls
 * the owner-authenticated `/api/dsh-costwatch-plugin` snapshot and renders today's USD
 * spend, the account's remaining credit, today's prompt cache hit rate, and
 * an hourly sparkline.
 *
 * The bundle is hand-authored in the Web module-loader factory format: it only
 * requires the platform's `react` seed.
 */
window.__ModuleLoader__.load({
  id: 'dsh-costwatch-plugin',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    const ENDPOINT = '/api/dsh-costwatch-plugin';
    const POLL_MS = 2000;
    const STYLE_TEXT = `
      @keyframes dshCostWatchPluginPulse {
        0%, 100% { opacity: .35; transform: scale(.8); }
        50% { opacity: 1; transform: scale(1); }
      }
      @keyframes dshCostWatchPluginSweep {
        0% { transform: translateX(-100%); }
        100% { transform: translateX(400%); }
      }
      .dsh-costwatch-plugin-dot {
        animation: dshCostWatchPluginPulse 2.4s ease-in-out infinite;
      }
      .dsh-costwatch-plugin-sweep {
        animation: dshCostWatchPluginSweep 5.5s linear infinite;
      }
      @media (prefers-reduced-motion: reduce) {
        .dsh-costwatch-plugin-dot, .dsh-costwatch-plugin-sweep { animation: none; }
      }
    `;

    /** Read the latest snapshot, treating failures after a success as stale data. */
    function useSnapshot() {
      const [state, setState] = React.useState({ status: 'loading', data: null, error: null });
      React.useEffect(() => {
        let alive = true;
        let timer;
        let delay = POLL_MS;
        const poll = async () => {
          try {
            const response = await fetch(ENDPOINT, {
              cache: 'no-store',
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (!alive) return;
            delay = POLL_MS;
            setState({ status: 'ready', data, error: null });
          } catch (error) {
            if (!alive) return;
            // Back off while the Host is unavailable, then resume the live cadence.
            delay = Math.min(Math.max(delay * 2, POLL_MS), 30_000);
            setState((previous) => ({
              status: previous.data === null ? 'error' : 'stale',
              data: previous.data,
              error: String(error?.message ?? error),
            }));
          }
          if (!alive) return;
          timer = setTimeout(poll, delay);
        };
        poll();
        return () => {
          alive = false;
          clearTimeout(timer);
        };
      }, []);
      return state;
    }

    /** `$0.0042` below a cent, `$1.234` below ten dollars, `$12.34` above. */
    function money(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      if (value < 0.01) return `$${value.toFixed(4)}`;
      if (value < 10) return `$${value.toFixed(3)}`;
      return `$${value.toFixed(2)}`;
    }

    /** One decimal below 100%, whole numbers at the edges. */
    function percent(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      const shown = value * 100;
      if (shown >= 99.95) return '100%';
      if (shown === 0) return '0%';
      return `${shown.toFixed(1)}%`;
    }

    function count(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
    }

    function clock(timeMs) {
      if (typeof timeMs !== 'number') return '—';
      return new Date(timeMs).toLocaleTimeString(undefined, { hour12: false });
    }

    const CURRENCY_SYMBOL = { USD: '$', CNY: '¥' };

    /** Format one server decimal string in its wallet currency. */
    function amountText(value, currency) {
      const symbol = CURRENCY_SYMBOL[currency] ?? `${currency} `;
      const amount = Number(value);
      return Number.isFinite(amount) ? `${symbol}${amount.toFixed(2)}` : `${symbol}${value}`;
    }

    function walletText(wallet) {
      return amountText(wallet.total, wallet.currency);
    }

    /** Remaining credit; keeps the last known amount through a failed refresh. */
    function creditText(balance) {
      if (balance === undefined || balance === null) return '—';
      if (balance.status === 'loading') return '…';
      if (balance.status === 'no-key') return '—';
      const wallets = Array.isArray(balance.wallets) ? balance.wallets : [];
      if (wallets.length === 0) return 'n/a';
      const primary = wallets.find((wallet) => wallet.currency === 'USD') ?? wallets[0];
      const text = walletText(primary);
      return wallets.length > 1 ? `${text} +${wallets.length - 1}` : text;
    }

    function creditTitle(balance) {
      if (balance === undefined || balance === null) return null;
      if (balance.status === 'loading') return 'credit: loading…';
      if (balance.status === 'no-key') return 'credit: no DeepSeek API key configured';
      const wallets = Array.isArray(balance.wallets) ? balance.wallets : [];
      const lines = wallets.map(
        (wallet) =>
          `credit: ${amountText(wallet.total, wallet.currency)} total (topped up ${amountText(wallet.toppedUp, wallet.currency)}, granted ${amountText(wallet.granted, wallet.currency)})`,
      );
      if (balance.status === 'unavailable') {
        const reason = balance.error === undefined ? '' : `: ${balance.error}`;
        return lines.length === 0
          ? `credit: unavailable${reason}`
          : [...lines, `credit: last known, refresh failed${reason}`].join('\n');
      }
      if (lines.length === 0) return 'credit: no wallet reported';
      if (balance.isAvailable === false) lines.push('credit: balance is below the usable threshold');
      return lines.join('\n');
    }

    function creditColor(balance) {
      if (balance?.status === 'unavailable') return 'var(--dsw-alias-state-warn-label, #d29922)';
      if (balance?.status === 'ready' && balance.isAvailable === false) {
        return 'var(--dsw-alias-state-error-primary, #f85149)';
      }
      if (balance?.status === 'no-key' || balance?.status === 'loading') {
        return 'var(--dsw-alias-label-tertiary, #8b949e)';
      }
      return 'var(--dsw-alias-label-primary, #e6edf3)';
    }

    /** Compact cache-hit meter; visual only, the number carries the value. */
    function HitMeter({ rate }) {
      const width = typeof rate === 'number' && Number.isFinite(rate) ? Math.max(2, Math.min(100, rate * 100)) : 0;
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            width: '34px',
            height: '3px',
            borderRadius: '2px',
            overflow: 'hidden',
            background: 'var(--dsw-alias-fill-l2, rgba(127,127,127,.28))',
            flex: 'none',
          },
        },
        h('span', {
          style: {
            width: `${width}%`,
            height: '100%',
            background: 'var(--dsw-alias-state-success-primary, #3fb950)',
          },
        }),
      );
    }

    /** 24 local-hour cost bars, with the current hour accented. */
    function HourlyBars({ values, current }) {
      const hours = Array.isArray(values) && values.length === 24 ? values : new Array(24).fill(0);
      const max = Math.max(1e-9, ...hours);
      const active =
        Number.isInteger(current) && current >= 0 && current <= 23
          ? current
          : new Date().getHours();
      return h(
        'span',
        {
          'aria-hidden': 'true',
          style: {
            display: 'inline-flex',
            alignItems: 'flex-end',
            gap: '1px',
            width: '68px',
            height: '13px',
            flex: 'none',
          },
        },
        hours.map((value, index) =>
          h('span', {
            key: index,
            style: {
              flex: '1 1 0',
              maxWidth: '3px',
              height: `${2 + (Math.max(0, value) / max) * 11}px`,
              borderRadius: '1px',
              background:
                index === active
                  ? 'var(--dsw-alias-brand-text, #58a6ff)'
                  : 'var(--dsw-alias-label-quaternary, rgba(127,127,127,.55))',
              opacity: value > 0 ? 1 : 0.45,
            },
          }),
        ),
      );
    }

    function UsageTicker() {
      const { status, data, error } = useSnapshot();
      const unavailable = status === 'error';
      const stale = status === 'stale';
      const loading =
        status === 'loading' || data === null || (data.loading === true && data.requests === 0);
      const dim = unavailable || stale;

      const tokens = data?.tokens ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
      const title = unavailable
        ? `dshCostWatchPlugin unavailable${error ? `: ${error}` : ''}`
        : loading
          ? 'dshCostWatchPlugin — reading today’s usage…'
          : [
              `dshCostWatchPlugin — usage today (${data.date}, ${data.peakNow ? 'peak' : 'off-peak'} now)`,
              `${money(data.usd)} · ${count(data.requests)} model calls`,
              creditTitle(data.balance),
              `input ${count(tokens.input)} · cache read ${count(tokens.cacheRead)} · cache write ${count(tokens.cacheWrite)} · output ${count(tokens.output)}`,
              `cache hit ${percent(data.cacheHit)}`,
              `updated ${clock(data.updatedAt)}`,
              data.unpricedModels?.length
                ? `unpriced models: ${data.unpricedModels.join(', ')}`
                : null,
              stale ? `last refresh failed (${error})` : null,
            ]
              .filter(Boolean)
              .join('\n');

      return h(
        'div',
        {
          role: 'group',
          'aria-label': title,
          title,
          style: {
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            boxSizing: 'border-box',
            height: '26px',
            padding: '0 12px',
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            userSelect: 'none',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: '11px',
            lineHeight: '1',
            letterSpacing: '0.01em',
            color: 'var(--dsw-alias-label-secondary, #8b949e)',
            background: 'var(--dsw-alias-bg-base, transparent)',
            borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18))',
            opacity: dim ? 0.65 : 1,
          },
        },
        h('style', { key: 'style' }, STYLE_TEXT),
        h('span', {
          key: 'sweep',
          className: 'dsh-costwatch-plugin-sweep',
          'aria-hidden': 'true',
          style: {
            position: 'absolute',
            top: 0,
            left: 0,
            width: '25%',
            height: '1px',
            pointerEvents: 'none',
            background:
              'linear-gradient(90deg, transparent, var(--dsw-alias-brand-text, #58a6ff), transparent)',
            opacity: 0.55,
          },
        }),
        h('span', {
          key: 'dot',
          className: 'dsh-costwatch-plugin-dot',
          style: {
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            flex: 'none',
            background: unavailable
              ? 'var(--dsw-alias-state-error-primary, #f85149)'
              : stale
                ? 'var(--dsw-alias-state-warn-label, #d29922)'
                : 'var(--dsw-alias-state-success-primary, #3fb950)',
          },
        }),
        h(
          'span',
          {
            key: 'live',
            style: { letterSpacing: '0.08em', opacity: 0.8, flex: 'none' },
          },
          unavailable ? 'OFFLINE' : stale ? 'STALE' : 'LIVE',
        ),
        h('span', {
          key: 'sep-1',
          style: { opacity: 0.35, flex: 'none' },
          children: '│',
        }),
        h(
          'span',
          { key: 'today', style: { flex: 'none', opacity: 0.8 } },
          'TODAY',
        ),
        h(
          'span',
          {
            key: 'usd',
            style: {
              flex: 'none',
              fontSize: '12px',
              fontWeight: 600,
              color: 'var(--dsw-alias-label-primary, #e6edf3)',
            },
          },
          loading ? '—' : money(data.usd),
        ),
        h('span', {
          key: 'sep-2',
          style: { opacity: 0.35, flex: 'none' },
          children: '·',
        }),
        h(
          'span',
          { key: 'cache-label', style: { flex: 'none', opacity: 0.8 } },
          'CACHE HIT',
        ),
        h(HitMeter, { key: 'meter', rate: loading ? null : data.cacheHit }),
        h(
          'span',
          {
            key: 'cache-value',
            style: {
              flex: 'none',
              fontWeight: 600,
              color: 'var(--dsw-alias-label-primary, #e6edf3)',
            },
          },
          loading ? '—' : percent(data.cacheHit),
        ),
        h('span', {
          key: 'sep-4',
          style: { opacity: 0.35, flex: 'none' },
          children: '·',
        }),
        h(HourlyBars, { key: 'bars', values: data?.hourlyUsd, current: data?.hour }),
        h('span', {
          key: 'spacer',
          style: { flex: '1 1 auto', minWidth: '4px' },
        }),
        h(
          'span',
          {
            key: 'calls',
            style: { flex: 'none', opacity: 0.7 },
          },
          loading ? '' : `${count(data.requests)} calls`,
        ),
        h(
          'span',
          {
            key: 'window',
            style: {
              flex: 'none',
              padding: '1px 5px',
              borderRadius: '4px',
              border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2))',
              color: data?.peakNow
                ? 'var(--dsw-alias-state-warn-label, #d29922)'
                : 'var(--dsw-alias-label-tertiary, #8b949e)',
              opacity: 0.9,
            },
          },
          loading ? '…' : data.peakNow ? 'PEAK' : 'OFF-PEAK',
        ),
        h('span', {
          key: 'sep-credit',
          style: { opacity: 0.35, flex: 'none' },
          children: '·',
        }),
        h(
          'span',
          { key: 'credit-label', style: { flex: 'none', opacity: 0.8 } },
          'CREDIT',
        ),
        h(
          'span',
          {
            key: 'credit-value',
            style: {
              flex: 'none',
              fontSize: '12px',
              fontWeight: 600,
              color: creditColor(data?.balance),
            },
          },
          loading ? '—' : creditText(data?.balance),
        ),
      );
    }

    /** Required Client services: the slot registry this bar contributes to. */
    const inject = ['slots'];

    /**
     * Register the bar in the frame's persistent bottom seat.
     * @param {object} ctx - Client root context.
     */
    function apply(ctx) {
      ctx.slots.inject('shell.bottom', () =>
        ctx.slots.register(
          {
            name: 'shell.bottom',
            id: 'dsh-costwatch-plugin',
            order: 0,
          },
          UsageTicker,
        ),
      );
    }

    exports.UsageTicker = UsageTicker;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
