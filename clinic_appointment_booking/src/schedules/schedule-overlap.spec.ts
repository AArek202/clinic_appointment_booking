import {
  findOverlappingWindow,
  ScheduleTimeWindow,
  windowsOverlap,
} from './schedule-overlap';

const sunday = (startTime: string, endTime: string): ScheduleTimeWindow => ({
  dayOfWeek: 0,
  startTime,
  endTime,
});

describe('windowsOverlap', () => {
  it('reports identical windows as overlapping', () => {
    expect(
      windowsOverlap(
        sunday('10:00:00', '16:00:00'),
        sunday('10:00:00', '16:00:00'),
      ),
    ).toBe(true);
  });

  it('reports an overlap when the candidate starts inside the existing window', () => {
    expect(
      windowsOverlap(
        sunday('15:00:00', '18:00:00'),
        sunday('10:00:00', '16:00:00'),
      ),
    ).toBe(true);
  });

  it('reports an overlap when the candidate ends inside the existing window', () => {
    expect(
      windowsOverlap(
        sunday('08:00:00', '11:00:00'),
        sunday('10:00:00', '16:00:00'),
      ),
    ).toBe(true);
  });

  it('reports an overlap when the candidate is fully contained', () => {
    expect(
      windowsOverlap(
        sunday('11:00:00', '12:00:00'),
        sunday('10:00:00', '16:00:00'),
      ),
    ).toBe(true);
  });

  it('reports an overlap when the candidate fully contains the existing window', () => {
    expect(
      windowsOverlap(
        sunday('08:00:00', '20:00:00'),
        sunday('10:00:00', '16:00:00'),
      ),
    ).toBe(true);
  });

  it('does not report adjacent windows as overlapping', () => {
    expect(
      windowsOverlap(
        sunday('16:00:00', '18:00:00'),
        sunday('10:00:00', '16:00:00'),
      ),
    ).toBe(false);
  });

  it('does not report separated windows as overlapping', () => {
    expect(
      windowsOverlap(
        sunday('17:00:00', '18:00:00'),
        sunday('10:00:00', '16:00:00'),
      ),
    ).toBe(false);
  });

  it('does not compare windows on different weekdays', () => {
    expect(
      windowsOverlap(
        { dayOfWeek: 1, startTime: '10:00:00', endTime: '16:00:00' },
        { dayOfWeek: 0, startTime: '10:00:00', endTime: '16:00:00' },
      ),
    ).toBe(false);
  });

  it('compares at second precision', () => {
    expect(
      windowsOverlap(
        sunday('10:00:30', '11:00:00'),
        sunday('10:00:00', '10:00:30'),
      ),
    ).toBe(false);
    expect(
      windowsOverlap(
        sunday('10:00:29', '11:00:00'),
        sunday('10:00:00', '10:00:30'),
      ),
    ).toBe(true);
  });
});

describe('findOverlappingWindow', () => {
  const existing = [
    { id: 'a', dayOfWeek: 0, startTime: '10:00:00', endTime: '12:00:00' },
    { id: 'b', dayOfWeek: 0, startTime: '14:00:00', endTime: '16:00:00' },
  ];

  it('returns the row that overlaps, with its own type preserved', () => {
    const found = findOverlappingWindow(
      sunday('15:00:00', '17:00:00'),
      existing,
    );

    expect(found?.id).toBe('b');
  });

  it('returns null when nothing overlaps', () => {
    expect(
      findOverlappingWindow(sunday('12:00:00', '14:00:00'), existing),
    ).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(
      findOverlappingWindow(sunday('10:00:00', '12:00:00'), []),
    ).toBeNull();
  });
});
