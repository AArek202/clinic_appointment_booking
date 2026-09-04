import { Rng } from './random';

describe('Rng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = new Rng(20260902);
    const b = new Rng(20260902);
    const first = [a.next(), a.next(), a.next(), a.next(), a.next()];
    const second = [b.next(), b.next(), b.next(), b.next(), b.next()];

    expect(first).toEqual(second);
  });

  it('produces a different sequence for a different seed', () => {
    const a = new Rng(1);
    const b = new Rng(2);

    expect(a.next()).not.toBe(b.next());
  });

  it('stays inside [0, 1)', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 1000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('returns integers inside the inclusive range', () => {
    const rng = new Rng(11);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(rng.int(3, 5));
    }

    expect([...seen].sort()).toEqual([3, 4, 5]);
  });

  it('honours chance() at the extremes', () => {
    const rng = new Rng(13);

    expect(rng.chance(1)).toBe(true);
    expect(rng.chance(0)).toBe(false);
  });
});
