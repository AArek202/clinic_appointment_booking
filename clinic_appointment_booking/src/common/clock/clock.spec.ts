import { FixedClock, SystemClock } from './clock';

describe('SystemClock', () => {
  it('returns the current time', () => {
    const before = Date.now();
    const now = new SystemClock().now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
  });
});

describe('FixedClock', () => {
  it('always returns the time it was constructed with', () => {
    const fixed = new Date('2026-09-06T09:00:00.000Z');
    const clock = new FixedClock(fixed);

    expect(clock.now()).toEqual(fixed);
    expect(clock.now()).toEqual(fixed);
  });

  it('can be advanced', () => {
    const clock = new FixedClock(new Date('2026-09-06T09:00:00.000Z'));
    clock.set(new Date('2026-09-06T14:00:00.000Z'));

    expect(clock.now().toISOString()).toBe('2026-09-06T14:00:00.000Z');
  });

  it('returns a copy, so callers cannot mutate the clock', () => {
    const clock = new FixedClock(new Date('2026-09-06T09:00:00.000Z'));
    const first = clock.now();
    first.setFullYear(1999);

    expect(clock.now().getFullYear()).toBe(2026);
  });
});
