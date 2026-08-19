import { loadPT, describe, it, eq, ok, report } from './harness.mjs';

const FILES = ['src/app/js/00-util.js', 'src/app/js/01-calendar.js'];
const { PT } = loadPT(FILES);
const C = PT.calendar;

const key = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

describe('holiday rules', () => {
  const h2026 = C.holidays(2026);
  const expect2026 = [
    [1, 1, "New Year's Day (Thu)"],
    [1, 19, 'MLK Jr Day (3rd Mon)'],
    [2, 16, 'Washington Birthday (3rd Mon)'],
    [4, 3, 'Good Friday (Easter Apr 5)'],
    [5, 25, 'Memorial Day (last Mon)'],
    [6, 19, 'Juneteenth (Fri)'],
    [7, 3, 'Independence Day observed (Jul 4 = Sat)'],
    [9, 7, 'Labor Day (1st Mon)'],
    [11, 26, 'Thanksgiving (4th Thu)'],
    [12, 25, 'Christmas (Fri)'],
  ];
  for (const [m, d, label] of expect2026) {
    it(`2026 closes for ${label}`, () => ok(h2026.has(key(2026, m, d)), `missing ${key(2026, m, d)}`));
  }
  it('2026 has exactly 10 full closures', () => eq(h2026.size, 10));

  // Cross-check a different year with well-known dates.
  const h2025 = C.holidays(2025);
  it('2025 Good Friday = Apr 18', () => ok(h2025.has('2025-04-18')));
  it('2025 Thanksgiving = Nov 27', () => ok(h2025.has('2025-11-27')));
  it('2025 Juneteenth = Jun 19', () => ok(h2025.has('2025-06-19')));
  it('2027 New Year on Fri Jan 1', () => ok(C.holidays(2027).has('2027-01-01')));
  // Jan 1 2022 was a Saturday -> NYSE did NOT close Dec 31 2021.
  it('Sat New Year is not observed on the prior Friday', () => ok(!C.holidays(2021).has('2021-12-31')));
});

describe('early closes', () => {
  const e2026 = C.earlyCloses(2026);
  it('2026 Black Friday Nov 27 closes early', () => ok(e2026.has('2026-11-27')));
  it('2026 Christmas Eve Dec 24 (Thu) closes early', () => ok(e2026.has('2026-12-24')));
  it('2026 July 3 is a full holiday, not an early close', () => ok(!e2026.has('2026-07-03')));
  it('2025 July 3 (Thu) closes early', () => ok(C.earlyCloses(2025).has('2025-07-03')));
});

describe('session phases (America/New_York)', () => {
  // 2026-08-19 is a Wednesday.
  const at = (h, m) => C.stockStatus(C.fromET(2026, 8, 19, h, m));
  it('03:00 ET -> closed', () => eq(at(3, 0).phase, 'closed'));
  it('05:00 ET -> pre-market', () => eq(at(5, 0).phase, 'pre'));
  it('09:29 ET -> pre-market', () => eq(at(9, 29).phase, 'pre'));
  it('09:30 ET -> open', () => eq(at(9, 30).phase, 'open'));
  it('15:59 ET -> open', () => eq(at(15, 59).phase, 'open'));
  it('16:00 ET -> after hours', () => eq(at(16, 0).phase, 'after'));
  it('20:00 ET -> closed', () => eq(at(20, 0).phase, 'closed'));

  it('Saturday is closed with weekend label', () => {
    const s = C.stockStatus(C.fromET(2026, 8, 22, 12, 0));
    eq(s.phase, 'closed'); eq(s.label, 'Weekend');
  });
  it('Christmas is closed with holiday label', () => {
    const s = C.stockStatus(C.fromET(2026, 12, 25, 12, 0));
    eq(s.phase, 'closed'); eq(s.label, 'Market holiday');
  });
  it('early-close day is closed at 13:30 and flagged early', () => {
    const s = C.stockStatus(C.fromET(2026, 11, 27, 13, 30));
    eq(s.phase, 'after'); eq(s.early, true);
  });
  it('early-close day is open at 12:59', () => {
    eq(C.stockStatus(C.fromET(2026, 11, 27, 12, 59)).phase, 'open');
  });
  it('crypto is always open', () => eq(C.cryptoStatus().isOpen, true));
});

describe('DST-correct wall-clock conversion', () => {
  it('summer (EDT) 09:30 ET = 13:30 UTC', () => {
    eq(new Date(C.fromET(2026, 8, 19, 9, 30)).toISOString(), '2026-08-19T13:30:00.000Z');
  });
  it('winter (EST) 09:30 ET = 14:30 UTC', () => {
    eq(new Date(C.fromET(2026, 1, 20, 9, 30)).toISOString(), '2026-01-20T14:30:00.000Z');
  });
  it('day before US DST start is EST', () => {
    eq(new Date(C.fromET(2026, 3, 7, 12, 0)).toISOString(), '2026-03-07T17:00:00.000Z');
  });
  it('day after US DST start is EDT', () => {
    eq(new Date(C.fromET(2026, 3, 9, 12, 0)).toISOString(), '2026-03-09T16:00:00.000Z');
  });
});

describe('next open', () => {
  it('Friday after close rolls to Monday 09:30', () => {
    const fri = C.fromET(2026, 8, 21, 17, 0);
    eq(new Date(C.stockStatus(fri).nextChange).toISOString(), '2026-08-24T13:30:00.000Z');
  });
  it('skips a holiday when finding the next session', () => {
    // Thu Dec 24 2026 (early close) -> Fri Dec 25 is Christmas -> Mon Dec 28.
    const eve = C.fromET(2026, 12, 24, 14, 0);
    eq(new Date(C.stockStatus(eve).nextChange).toISOString(), '2026-12-28T14:30:00.000Z');
  });
  it('open session reports its own close time', () => {
    const s = C.stockStatus(C.fromET(2026, 8, 19, 11, 0));
    eq(s.nextLabel, 'Closes');
    eq(new Date(s.nextChange).toISOString(), '2026-08-19T20:00:00.000Z');
  });
});

report('calendar');
