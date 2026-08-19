/* =========================================================================
   PT — Paper Trader. Shared namespace, formatting and math helpers.
   ========================================================================= */
window.PT = window.PT || {};

(function (PT) {
  'use strict';

  /* ---------------------------------------------------------------- money */

  /** Round to n decimal places without float drift (0.1+0.2 style errors). */
  function round(value, dp) {
    if (!isFinite(value)) return 0;
    const f = Math.pow(10, dp);
    // Nudge by Number.EPSILON so 1.005 -> 1.01 rather than 1.00.
    return Math.round((value + Number.EPSILON * Math.sign(value) * Math.abs(value)) * f) / f;
  }

  const money = (v) => round(v, 2);

  /** Quantity precision differs by asset class: coins need far more decimals. */
  function roundQty(qty, kind) {
    return round(qty, kind === 'crypto' ? 8 : 6);
  }

  /**
   * Round a quantity DOWN to its precision. Sizing by dollars must never round
   * up: `notional / price` rounded up costs marginally more than the dollars
   * the user asked to spend, which is exactly enough to fail an
   * "invest my whole balance" order.
   */
  function floorQty(qty, kind) {
    if (!isFinite(qty) || qty <= 0) return 0;
    const f = Math.pow(10, kind === 'crypto' ? 8 : 6);
    // Nudge first so 0.29999999999 (a representation artefact) floors to 0.3.
    return Math.floor(qty * f + 1e-6) / f;
  }

  /* ------------------------------------------------------------ formatting */

  const nf = (min, max) => new Intl.NumberFormat('en-US', {
    minimumFractionDigits: min, maximumFractionDigits: max,
  });
  const cache = new Map();
  function fmtNum(v, min, max) {
    const key = min + ':' + max;
    if (!cache.has(key)) cache.set(key, nf(min, max));
    return cache.get(key).format(v);
  }

  /** Currency with sensible precision — sub-penny assets keep their digits. */
  function fmtUSD(v, opts = {}) {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v);
    let dp = 2;
    if (!opts.fixed2) {
      if (a > 0 && a < 0.0001) dp = 8;
      else if (a < 0.01) dp = 6;
      else if (a < 1) dp = 4;
    }
    const sign = v < 0 ? '-' : '';
    return sign + '$' + fmtNum(Math.abs(v), dp, dp);
  }

  /** Signed currency, e.g. "+$1,204.53" — for P&L. */
  function fmtSigned(v) {
    if (v == null || !isFinite(v)) return '—';
    return (v > 0 ? '+' : v < 0 ? '-' : '') + '$' + fmtNum(Math.abs(v), 2, 2);
  }

  function fmtPct(v, dp = 2) {
    if (v == null || !isFinite(v)) return '—';
    return (v > 0 ? '+' : '') + fmtNum(v, dp, dp) + '%';
  }

  /** Magnitude only — for prose that supplies its own direction word. */
  function fmtPctAbs(v, dp = 2) {
    if (v == null || !isFinite(v)) return '—';
    return fmtNum(Math.abs(v), dp, dp) + '%';
  }

  /** Compact quantity: hide trailing zeros but keep small coin amounts readable. */
  function fmtQty(v) {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1000) return fmtNum(v, 0, 2);
    if (a >= 1) return fmtNum(v, 0, 4);
    if (a >= 0.0001) return fmtNum(v, 0, 6);
    return fmtNum(v, 0, 8);
  }

  /** 1_234_567 -> "1.23M" for market caps and volume. */
  function fmtCompact(v) {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v);
    const s = v < 0 ? '-' : '';
    if (a >= 1e12) return s + fmtNum(a / 1e12, 2, 2) + 'T';
    if (a >= 1e9) return s + fmtNum(a / 1e9, 2, 2) + 'B';
    if (a >= 1e6) return s + fmtNum(a / 1e6, 2, 2) + 'M';
    if (a >= 1e3) return s + fmtNum(a / 1e3, 1, 1) + 'K';
    return s + fmtNum(a, 0, 2);
  }

  const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const dateTimeFmt = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  const fmtTime = (ms) => timeFmt.format(new Date(ms));
  const fmtDateTime = (ms) => dateTimeFmt.format(new Date(ms));

  /** "just now" / "12s ago" / "4m ago" — for data freshness labels. */
  function fmtAge(ms) {
    if (!ms) return 'never';
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 2) return 'just now';
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  /* ----------------------------------------------------------------- misc */

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function uid(prefix) {
    return (prefix || 'id') + '_' +
      Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /** Trailing-edge debounce, with a cancel so a pending call can be abandoned. */
  function debounce(fn, wait) {
    let t;
    const wrapped = function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
    wrapped.cancel = () => clearTimeout(t);
    return wrapped;
  }

  /** Escape untrusted strings before they touch innerHTML. */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Tiny DOM builder: el('div', {class:'x'}, 'text' | childNode | [..]) */
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v);
      }
    }
    if (children != null) {
      const list = Array.isArray(children) ? children : [children];
      for (const c of list) {
        if (c == null || c === false) continue;
        node.appendChild(typeof c === 'string' || typeof c === 'number'
          ? document.createTextNode(String(c)) : c);
      }
    }
    return node;
  }

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** Sign-based CSS class used everywhere for green/red numbers. */
  const dirClass = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');

  /* --------------------------------------------------------------- events */

  /** Minimal pub/sub so modules stay decoupled from the UI. */
  function emitter() {
    const map = new Map();
    return {
      on(evt, fn) {
        if (!map.has(evt)) map.set(evt, new Set());
        map.get(evt).add(fn);
        return () => map.get(evt).delete(fn);
      },
      emit(evt, payload) {
        const set = map.get(evt);
        if (!set) return;
        for (const fn of set) {
          try { fn(payload); } catch (e) { console.error('[PT] listener error', evt, e); }
        }
      },
    };
  }

  PT.util = {
    round, money, roundQty, floorQty, fmtUSD, fmtSigned, fmtPct, fmtPctAbs, fmtQty, fmtCompact,
    fmtNum, fmtTime, fmtDateTime, fmtAge, clamp, uid, debounce, esc, el, $, $$,
    dirClass, emitter,
  };
})(window.PT);
