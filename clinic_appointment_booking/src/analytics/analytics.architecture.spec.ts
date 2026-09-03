import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOCTOR_MONTHLY_ANALYTICS_SQL } from './analytics.sql';

const SOURCES = ['analytics.repository.ts', 'analytics.service.ts', 'analytics.controller.ts'];

// docs/FEATURES/Analytics.md: "The calculations MUST happen in PostgreSQL."
// Every one of these patterns is a way of loading rows and aggregating them in
// JavaScript, which is the failure mode this whole feature is written to avoid.
const FORBIDDEN = [
  /\.find\(/,
  /\.findOne\(/,
  /\.reduce\(/,
  /\.filter\(/,
  /createQueryBuilder/,
  /InjectRepository/,
];

describe('the analytics path computes in PostgreSQL, not in JavaScript', () => {
  it.each(SOURCES)('%s contains no row-level aggregation', (file) => {
    const source = readFileSync(join(__dirname, file), 'utf8');

    for (const pattern of FORBIDDEN) {
      expect(source).not.toMatch(pattern);
    }
  });

  it('does the aggregation in SQL', () => {
    // The four metrics, each traceable to an aggregate in the query.
    expect(DOCTOR_MONTHLY_ANALYTICS_SQL).toContain('COUNT(*)');
    expect(DOCTOR_MONTHLY_ANALYTICS_SQL).toContain("FILTER (WHERE a.status = 'CANCELLED')");
    expect(DOCTOR_MONTHLY_ANALYTICS_SQL).toContain('array_agg(h.hour ORDER BY h.hour)');
    expect(DOCTOR_MONTHLY_ANALYTICS_SQL).toContain('range_agg(');
  });

  it('guards both divisions with NULLIF', () => {
    expect(DOCTOR_MONTHLY_ANALYTICS_SQL).toContain('NULLIF(s.total, 0)');
    expect(DOCTOR_MONTHLY_ANALYTICS_SQL).toContain('NULLIF(c.available_minutes, 0)');
  });

  it('bounds the month in clinic-local time, using the timezone parameter', () => {
    // $4 is CLINIC_TZ. If either boundary were built without it, the month
    // would be a UTC month.
    expect(DOCTOR_MONTHLY_ANALYTICS_SQL).toContain(
      "make_date($2::int, $3::int, 1)::timestamp AT TIME ZONE $4::text",
    );
  });
});
