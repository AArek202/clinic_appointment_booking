import { encodeCopyRow, encodeCopyValue } from './copy-writer';

describe('encodeCopyValue', () => {
  it('encodes null as the COPY null marker', () => {
    expect(encodeCopyValue(null)).toBe('\\N');
  });

  it('encodes a Date as an ISO-8601 UTC instant', () => {
    expect(encodeCopyValue(new Date('2026-09-06T07:00:00.000Z'))).toBe(
      '2026-09-06T07:00:00.000Z',
    );
  });

  it('encodes booleans and numbers as text', () => {
    expect(encodeCopyValue(true)).toBe('true');
    expect(encodeCopyValue(30)).toBe('30');
  });

  it('escapes backslash, tab, newline and carriage return', () => {
    expect(encodeCopyValue('a\\b\tc\nd\re')).toBe('a\\\\b\\tc\\nd\\re');
  });

  it('leaves ordinary text alone', () => {
    expect(encodeCopyValue("O'Brien")).toBe("O'Brien");
  });
});

describe('encodeCopyRow', () => {
  it('joins values with tabs and terminates the row with a newline', () => {
    expect(encodeCopyRow(['a', 1, null])).toBe('a\t1\t\\N\n');
  });
});
