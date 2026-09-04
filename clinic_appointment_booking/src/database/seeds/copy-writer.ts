import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { PoolClient } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';

export type CopyValue = string | number | boolean | Date | null;

const NULL_MARKER = '\\N';
const BLOCK_BYTES = 64 * 1024;

/** Escapes one value for PostgreSQL's COPY text format. */
export function encodeCopyValue(value: CopyValue): string {
  if (value === null) {
    return NULL_MARKER;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== 'string') {
    return String(value);
  }

  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

export function encodeCopyRow(values: CopyValue[]): string {
  return `${values.map(encodeCopyValue).join('\t')}\n`;
}

/** Groups pre-encoded rows into ~64 KB blocks so the stream does fewer writes. */
function* blocks(rows: Iterable<string>): Generator<string> {
  let buffer = '';

  for (const row of rows) {
    buffer += row;
    if (buffer.length >= BLOCK_BYTES) {
      yield buffer;
      buffer = '';
    }
  }

  if (buffer.length > 0) {
    yield buffer;
  }
}

/**
 * Streams pre-encoded rows into a table with COPY ... FROM STDIN.
 *
 * Chosen over multi-row INSERT for two reasons. PostgreSQL accepts at most
 * 65535 bind parameters per statement, which caps an appointments INSERT
 * (10 columns) at about 6500 rows and forces thousands of round trips; and
 * every one of those statements pays parse and plan cost that COPY pays once.
 */
export async function copyRows(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: Iterable<string>,
): Promise<void> {
  const stream = client.query(
    copyFrom(`COPY ${table} (${columns.join(', ')}) FROM STDIN`),
  );
  await pipeline(Readable.from(blocks(rows)), stream);
}
