import { overlaps } from './slot-generator';

const range = (startIso: string, endIso: string) => ({
  startAt: new Date(startIso),
  endAt: new Date(endIso),
});

describe('overlaps', () => {
  it('detects a partial overlap', () => {
    expect(
      overlaps(
        range('2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z'),
        range('2026-10-05T10:15:00Z', '2026-10-05T10:45:00Z'),
      ),
    ).toBe(true);
  });

  it('detects full containment', () => {
    expect(
      overlaps(
        range('2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z'),
        range('2026-10-05T09:00:00Z', '2026-10-05T17:00:00Z'),
      ),
    ).toBe(true);
  });

  it('treats touching ranges as NOT overlapping', () => {
    // 10:00-10:30 and 10:30-11:00 are back-to-back, not overlapping.
    // Getting this wrong rejects every consecutive booking.
    expect(
      overlaps(
        range('2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z'),
        range('2026-10-05T10:30:00Z', '2026-10-05T11:00:00Z'),
      ),
    ).toBe(false);
  });

  it('treats disjoint ranges as not overlapping', () => {
    expect(
      overlaps(
        range('2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z'),
        range('2026-10-05T14:00:00Z', '2026-10-05T14:30:00Z'),
      ),
    ).toBe(false);
  });

  it('is symmetric', () => {
    const a = range('2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z');
    const b = range('2026-10-05T10:15:00Z', '2026-10-05T10:45:00Z');

    expect(overlaps(a, b)).toBe(overlaps(b, a));
  });
});
