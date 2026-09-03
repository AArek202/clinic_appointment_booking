import { normalizeTimeOfDay, timeOfDayToSeconds } from './time-of-day';

describe('timeOfDayToSeconds', () => {
  it('parses HH:mm', () => {
    expect(timeOfDayToSeconds('10:00')).toBe(36_000);
  });

  it('parses HH:mm:ss', () => {
    expect(timeOfDayToSeconds('10:00:30')).toBe(36_030);
  });

  it('parses midnight as zero', () => {
    expect(timeOfDayToSeconds('00:00')).toBe(0);
  });

  it('parses the last second of the day', () => {
    expect(timeOfDayToSeconds('23:59:59')).toBe(86_399);
  });

  it('rejects hour 24', () => {
    expect(() => timeOfDayToSeconds('24:00')).toThrow(/24:00/);
  });

  it('rejects minute 60', () => {
    expect(() => timeOfDayToSeconds('10:60')).toThrow(/10:60/);
  });

  it('rejects a single-digit hour', () => {
    expect(() => timeOfDayToSeconds('9:00')).toThrow(/9:00/);
  });

  it('rejects an empty string', () => {
    expect(() => timeOfDayToSeconds('')).toThrow();
  });
});

describe('normalizeTimeOfDay', () => {
  it('pads HH:mm to HH:mm:ss', () => {
    expect(normalizeTimeOfDay('10:00')).toBe('10:00:00');
  });

  it('leaves HH:mm:ss unchanged', () => {
    expect(normalizeTimeOfDay('09:05:07')).toBe('09:05:07');
  });
});
