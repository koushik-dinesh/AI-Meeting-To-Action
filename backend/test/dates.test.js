import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addDays, isValidIsoDate, localDate, resolveDeadline, weekdayName } from '../src/utils/dates.js';

const REF = '2026-11-04'; // a Wednesday
const r = (raw, ref = REF) => resolveDeadline(raw, ref);

describe('date helpers', () => {
  it('handles calendar arithmetic and timezones', () => {
    assert.equal(weekdayName(REF), 'Wednesday');
    assert.equal(addDays('2026-12-30', 3), '2027-01-02');
    assert.equal(isValidIsoDate('2026-02-30'), false);
    assert.equal(localDate(new Date('2026-11-02T23:30:00Z'), 'Asia/Tokyo'), '2026-11-03');
    assert.equal(localDate(new Date('2026-11-02T23:30:00Z'), 'UTC'), '2026-11-02');
  });
});

describe('resolveDeadline', () => {
  it('resolves unambiguous relative and absolute expressions', () => {
    assert.equal(r('by Friday').date, '2026-11-06');
    assert.equal(r('this coming Monday').date, '2026-11-09');
    assert.equal(r('tomorrow').date, '2026-11-05');
    assert.equal(r('end of day').date, REF);
    assert.equal(r('in two weeks').date, '2026-11-18');
    assert.equal(r('in 3 days').date, '2026-11-07');
    assert.equal(r('by the end of the month').date, '2026-11-30');
    assert.equal(r('Nov 20th').date, '2026-11-20');
    assert.equal(r('20 November 2026').date, '2026-11-20');
    assert.equal(r('2026-12-01').date, '2026-12-01');
    assert.equal(r('January 15').date, '2027-01-15', 'month far behind the meeting rolls to next year');
  });

  it('leaves ambiguous expressions unresolved', () => {
    for (const raw of ['next Friday', 'Wednesday', 'next week', 'soon', 'ASAP', '11/12', 'October 30', 'end of the quarter']) {
      const res = r(raw);
      assert.equal(res.ambiguous, true, raw);
      assert.equal(res.date, undefined, raw);
    }
  });

  it('only resolves absolute dates without a meeting date', () => {
    assert.equal(resolveDeadline('2026-12-01', null).date, '2026-12-01');
    assert.equal(resolveDeadline('Friday', null).ambiguous, true);
    assert.equal(resolveDeadline('tomorrow', null).ambiguous, true);
  });

  it('reports expressions it does not understand', () => {
    assert.equal(r('el viernes').recognized, false);
    assert.equal(r('by the 20th').recognized, false);
    assert.equal(r('Feb 30').recognized, false);
  });
});
