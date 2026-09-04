const BUCKET_MINUTES = 15;
const BUCKET_MS = BUCKET_MINUTES * 60_000;

/**
 * Tracks which 15-minute buckets each patient already occupies.
 *
 * Every slot boundary the seed produces is a multiple of 15 minutes past the
 * hour and every allowed slot duration (15, 30, 60) is a multiple of 15, so
 * "the bucket sets are disjoint" is exactly "the half-open intervals do not
 * overlap" — the same test appointments_patient_no_overlap performs. There is
 * no approximation here, which is why the seed can load two million rows with
 * that constraint enabled and never trip it.
 *
 * Only CONFIRMED appointments are tracked. Both exclusion constraints are
 * partial on status = 'CONFIRMED', so cancelled rows are unconstrained and
 * deliberately neither check nor claim.
 */
export class PatientOccupancy {
  private readonly taken = new Set<number>();

  constructor(
    private readonly epochMs: number,
    private readonly patientCount: number,
  ) {}

  isFree(patientIndex: number, startAt: Date, endAt: Date): boolean {
    const [first, last] = this.bucketRange(startAt, endAt);

    for (let bucket = first; bucket < last; bucket += 1) {
      if (this.taken.has(this.key(patientIndex, bucket))) {
        return false;
      }
    }

    return true;
  }

  claim(patientIndex: number, startAt: Date, endAt: Date): void {
    const [first, last] = this.bucketRange(startAt, endAt);

    for (let bucket = first; bucket < last; bucket += 1) {
      this.taken.add(this.key(patientIndex, bucket));
    }
  }

  private bucketRange(startAt: Date, endAt: Date): [number, number] {
    return [
      Math.floor((startAt.getTime() - this.epochMs) / BUCKET_MS),
      Math.ceil((endAt.getTime() - this.epochMs) / BUCKET_MS),
    ];
  }

  private key(patientIndex: number, bucket: number): number {
    return bucket * this.patientCount + patientIndex;
  }
}
