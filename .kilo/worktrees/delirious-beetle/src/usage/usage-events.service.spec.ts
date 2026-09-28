import { changeRatio, isoDay, periodBounds } from './usage-events.service';

describe('periodBounds', () => {
  const now = new Date('2026-09-24T14:30:00.000Z');

  it('covers the last N UTC days ending today, and the N before them', () => {
    const { days, from, previousFrom, to } = periodBounds('7d', now);

    expect(days).toBe(7);
    expect(from.toISOString()).toBe('2026-09-18T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-09-25T00:00:00.000Z');
    expect(previousFrom.toISOString()).toBe('2026-09-11T00:00:00.000Z');
    expect((to.getTime() - from.getTime()) / 86_400_000).toBe(7);
  });

  it('supports the 30 and 90 day ranges', () => {
    expect(periodBounds('30d', now).days).toBe(30);
    expect(periodBounds('90d', now).from.toISOString()).toBe(
      '2026-06-27T00:00:00.000Z',
    );
  });

  it('rolls over month and year boundaries', () => {
    const { from, previousFrom } = periodBounds(
      '7d',
      new Date('2027-01-03T10:00:00.000Z'),
    );
    expect(from.toISOString()).toBe('2026-12-28T00:00:00.000Z');
    expect(previousFrom.toISOString()).toBe('2026-12-21T00:00:00.000Z');
  });
});

describe('changeRatio', () => {
  it('is the relative change versus the previous period', () => {
    expect(changeRatio(120, 100)).toBeCloseTo(0.2);
    expect(changeRatio(50, 100)).toBeCloseTo(-0.5);
    expect(changeRatio(100, 100)).toBe(0);
  });

  it('is 0 — not Infinity or NaN — when there was nothing before to compare with', () => {
    expect(changeRatio(10, 0)).toBe(0);
    expect(changeRatio(0, 0)).toBe(0);
  });
});

describe('isoDay', () => {
  it('formats a date as its UTC day', () => {
    expect(isoDay(new Date('2026-09-24T23:59:59.999Z'))).toBe('2026-09-24');
  });
});
