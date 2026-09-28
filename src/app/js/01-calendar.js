/* =========================================================================
   US equity market calendar.

   Everything here is computed from NYSE/Nasdaq holiday *rules* rather than a
   hardcoded date list, so it stays correct in any year. All arithmetic is done
   in America/New_York wall-clock time and converted back to UTC instants with
   a two-pass DST correction.
   ========================================================================= */
(function (PT) {
  'use strict';

  const ET = 'America/New_York';

  const etParts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });

  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  /** Wall-clock fields of `ts` as observed in New York. */
  function inET(ts) {
    const p = {};
    for (const part of etParts.formatToParts(new Date(ts))) p[part.type] = part.value;
    const hour = p.hour === '24' ? 0 : +p.hour; // Intl emits 24 for midnight
    return {
      y: +p.year, m: +p.month, d: +p.day,
      hh: hour, mm: +p.minute, ss: +p.second,
      dow: WD[p.weekday],
      minutes: hour * 60 + (+p.minute),
    };
  }

  /** UTC offset of New York at instant `ts`, in ms (e.g. -14400000 in EDT). */
  function etOffset(ts) {
    const p = inET(ts);
    return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(ts / 1000) * 1000;
  }

  /**
   * Convert a New York wall-clock date+time into a UTC timestamp.
   * Two passes: guess with the offset at the naive instant, then re-resolve
   * using the offset that actually applies at the guessed instant. This is
   * correct across both DST transitions.
   */
  function fromET(y, m, d, hh = 0, mm = 0) {
    const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
    let ts = naive - etOffset(naive);
    ts = naive - etOffset(ts);
    return ts;
  }

  const dayKey = (p) => `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;

  /* ------------------------------------------------------------- holidays */

  /** Day-of-week of a Y/M/D in the proleptic Gregorian calendar. */
  const dowOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

  /** nth (1-based) `dow` of a month; n = -1 means the last one. */
  function nthDow(y, m, dow, n) {
    if (n > 0) {
      const first = dowOf(y, m, 1);
      return 1 + ((dow - first + 7) % 7) + (n - 1) * 7;
    }
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const lastDow = dowOf(y, m, last);
    return last - ((lastDow - dow + 7) % 7);
  }

  /** Easter Sunday, anonymous Gregorian algorithm. */
  function easter(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100;
    const d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return { m: month, d: day };
  }

  /**
   * Weekend-observance shift used by the NYSE: a holiday on Saturday is
   * observed the preceding Friday, on Sunday the following Monday.
   * New Year's Day is the documented exception — when Jan 1 is a Saturday the
   * exchange does not close on Dec 31.
   */
  function observed(y, m, d, isNewYear) {
    const dow = dowOf(y, m, d);
    if (dow === 6) return isNewYear ? null : { y, m, d: d - 1 };
    if (dow === 0) return { y, m, d: d + 1 };
    return { y, m, d };
  }

  const holidayCache = new Map();

  /** Set of 'YYYY-MM-DD' full-closure days for a year. */
  function holidays(y) {
    if (holidayCache.has(y)) return holidayCache.get(y);
    const out = new Set();
    const add = (o) => { if (o) out.add(`${o.y}-${String(o.m).padStart(2, '0')}-${String(o.d).padStart(2, '0')}`); };

    add(observed(y, 1, 1, true));                       // New Year's Day
    add({ y, m: 1, d: nthDow(y, 1, 1, 3) });            // MLK Jr. Day
    add({ y, m: 2, d: nthDow(y, 2, 1, 3) });            // Washington's Birthday
    const e = easter(y);                                 // Good Friday (2 days before Easter)
    const gf = new Date(Date.UTC(y, e.m - 1, e.d - 2));
    add({ y: gf.getUTCFullYear(), m: gf.getUTCMonth() + 1, d: gf.getUTCDate() });
    add({ y, m: 5, d: nthDow(y, 5, 1, -1) });           // Memorial Day
    add(observed(y, 6, 19));                             // Juneteenth
    add(observed(y, 7, 4));                              // Independence Day
    add({ y, m: 9, d: nthDow(y, 9, 1, 1) });            // Labor Day
    add({ y, m: 11, d: nthDow(y, 11, 4, 4) });          // Thanksgiving
    add(observed(y, 12, 25));                            // Christmas

    holidayCache.set(y, out);
    return out;
  }

  const earlyCache = new Map();

  /** Set of 'YYYY-MM-DD' 1:00pm-ET early-close days for a year. */
  function earlyCloses(y) {
    if (earlyCache.has(y)) return earlyCache.get(y);
    const out = new Set();
    const key = (m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const hol = holidays(y);

    // July 3, when it is itself a weekday trading session.
    const jul3dow = dowOf(y, 7, 3);
    if (jul3dow >= 1 && jul3dow <= 5 && !hol.has(key(7, 3))) out.add(key(7, 3));

    // The Friday after Thanksgiving.
    const tg = nthDow(y, 11, 4, 4);
    out.add(key(11, tg + 1));

    // Christmas Eve, when it falls Monday–Thursday.
    const ce = dowOf(y, 12, 24);
    if (ce >= 1 && ce <= 4 && !hol.has(key(12, 24))) out.add(key(12, 24));

    earlyCache.set(y, out);
    return out;
  }

  /* -------------------------------------------------------------- session */

  const PRE_OPEN = 4 * 60;        // 04:00 ET
  const REG_OPEN = 9 * 60 + 30;   // 09:30 ET
  const REG_CLOSE = 16 * 60;      // 16:00 ET
  const EARLY_CLOSE = 13 * 60;    // 13:00 ET
  const POST_CLOSE = 20 * 60;     // 20:00 ET
  const EARLY_POST_CLOSE = 17 * 60; // 17:00 ET — post-market ends early on half-days

  const isWeekend = (p) => p.dow === 0 || p.dow === 6;
  const isHoliday = (p) => holidays(p.y).has(dayKey(p));
  const isTradingDay = (p) => !isWeekend(p) && !isHoliday(p);
  const closeMinuteFor = (p) => (earlyCloses(p.y).has(dayKey(p)) ? EARLY_CLOSE : REG_CLOSE);

  /** Step to the next trading day's 09:30 ET, searching forward. */
  function nextOpenTs(fromTs) {
    let p = inET(fromTs);
    // If today is still a trading day and the bell hasn't rung, it's today.
    if (isTradingDay(p) && p.minutes < REG_OPEN) return fromET(p.y, p.m, p.d, 9, 30);
    for (let i = 1; i <= 10; i++) {
      const probe = inET(fromET(p.y, p.m, p.d, 12, 0) + i * 86400000);
      if (isTradingDay(probe)) return fromET(probe.y, probe.m, probe.d, 9, 30);
    }
    return null;
  }

  /**
   * Full market status for stocks at `ts`.
   * phase: 'open' | 'pre' | 'after' | 'closed'
   */
  function stockStatus(ts = Date.now()) {
    const p = inET(ts);
    const trading = isTradingDay(p);
    const closeMin = closeMinuteFor(p);
    const early = trading && closeMin === EARLY_CLOSE;
    const postClose = closeMin === EARLY_CLOSE ? EARLY_POST_CLOSE : POST_CLOSE;

    let phase = 'closed';
    if (trading) {
      if (p.minutes >= REG_OPEN && p.minutes < closeMin) phase = 'open';
      else if (p.minutes >= PRE_OPEN && p.minutes < REG_OPEN) phase = 'pre';
      else if (p.minutes >= closeMin && p.minutes < postClose) phase = 'after';
    }

    const label = phase === 'open' ? 'Market open'
      : phase === 'pre' ? 'Pre-market'
        : phase === 'after' ? 'After hours'
          : !trading && isHoliday(p) ? 'Market holiday'
            : isWeekend(p) ? 'Weekend' : 'Market closed';

    let nextChange = null, nextLabel = '';
    if (phase === 'open') {
      nextChange = fromET(p.y, p.m, p.d, Math.floor(closeMin / 60), closeMin % 60);
      nextLabel = 'Closes';
    } else {
      nextChange = nextOpenTs(ts);
      nextLabel = 'Opens';
    }

    return {
      phase, label, isOpen: phase === 'open', early,
      nextChange, nextLabel,
      etTime: `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`,
      etDate: dayKey(p),
    };
  }

  /** Crypto never closes — kept symmetric so the UI can treat both the same. */
  function cryptoStatus() {
    return { phase: 'open', label: '24/7 market', isOpen: true, early: false, nextChange: null, nextLabel: '' };
  }

  const statusFor = (kind, ts) => (kind === 'crypto' ? cryptoStatus() : stockStatus(ts));

  /** "2h 14m" countdown text. */
  function untilText(ts, now = Date.now()) {
    if (!ts) return '';
    let s = Math.max(0, Math.floor((ts - now) / 1000));
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
  }

  /** The Eastern-time calendar date of an instant, as 'YYYY-MM-DD'. */
  const etDateOf = (ts) => dayKey(inET(ts));

  PT.calendar = {
    inET, fromET, etOffset, etDateOf, holidays, earlyCloses, isTradingDay,
    stockStatus, cryptoStatus, statusFor, nextOpenTs, untilText,
  };
})(window.PT);
