import { PatientOccupancy } from './occupancy';

const EPOCH = Date.parse('2026-01-01T00:00:00.000Z');

function at(iso: string): Date {
  return new Date(iso);
}

describe('PatientOccupancy', () => {
  it('reports a fresh patient as free', () => {
    const occupancy = new PatientOccupancy(EPOCH, 10);

    expect(
      occupancy.isFree(0, at('2026-03-01T09:00:00Z'), at('2026-03-01T09:30:00Z')),
    ).toBe(true);
  });

  it('reports a claimed interval as busy', () => {
    const occupancy = new PatientOccupancy(EPOCH, 10);
    occupancy.claim(0, at('2026-03-01T09:00:00Z'), at('2026-03-01T09:30:00Z'));

    expect(
      occupancy.isFree(0, at('2026-03-01T09:00:00Z'), at('2026-03-01T09:30:00Z')),
    ).toBe(false);
  });

  it('treats back-to-back intervals as free, matching the half-open range bound', () => {
    const occupancy = new PatientOccupancy(EPOCH, 10);
    occupancy.claim(0, at('2026-03-01T09:00:00Z'), at('2026-03-01T09:30:00Z'));

    expect(
      occupancy.isFree(0, at('2026-03-01T09:30:00Z'), at('2026-03-01T10:00:00Z')),
    ).toBe(true);
  });

  it('detects a short interval nested inside a longer claim', () => {
    const occupancy = new PatientOccupancy(EPOCH, 10);
    occupancy.claim(0, at('2026-03-01T09:00:00Z'), at('2026-03-01T10:00:00Z'));

    expect(
      occupancy.isFree(0, at('2026-03-01T09:15:00Z'), at('2026-03-01T09:30:00Z')),
    ).toBe(false);
  });

  it('detects a partial overlap at the start of a claim', () => {
    const occupancy = new PatientOccupancy(EPOCH, 10);
    occupancy.claim(0, at('2026-03-01T09:30:00Z'), at('2026-03-01T10:00:00Z'));

    expect(
      occupancy.isFree(0, at('2026-03-01T09:15:00Z'), at('2026-03-01T09:45:00Z')),
    ).toBe(false);
  });

  it('keeps patients independent of each other', () => {
    const occupancy = new PatientOccupancy(EPOCH, 10);
    occupancy.claim(0, at('2026-03-01T09:00:00Z'), at('2026-03-01T09:30:00Z'));

    expect(
      occupancy.isFree(1, at('2026-03-01T09:00:00Z'), at('2026-03-01T09:30:00Z')),
    ).toBe(true);
  });
});
