export type TierName = 'popular' | 'busy' | 'regular' | 'quiet';

export interface ScheduleWindowSpec {
  startTime: string; // 'HH:mm:ss', clinic-local
  endTime: string;
}

export interface DoctorTier {
  name: TierName;
  doctors: number;
  /** 0 = Sunday .. 6 = Saturday, matching EXTRACT(DOW) and schedules.day_of_week. */
  workingDays: number[];
  windows: ScheduleWindowSpec[];
  slotDurationMinutes: 15 | 30 | 60;
  appointmentsPerDoctor: number;
}

export interface SeedConfig {
  scale: 'full' | 'small';
  randomSeed: number;
  patients: number;
  monthsPast: number;
  monthsFuture: number;
  cancelledFraction: number;
  /** Share of cancelled slots that get a second, CONFIRMED appointment. */
  rebookedFraction: number;
  /** Share of confirmed appointments recorded as created_from = WAITING_LIST. */
  waitingListSourceFraction: number;
  blocksPerDoctorPerYear: number;
  waitingListEntries: number;
  contestedReservoir: number;
  copyChunkRows: number;
  tiers: DoctorTier[];
}

/** Every seeded user shares this password. See the Global Constraints. */
export const SEED_PASSWORD = 'Password123!';

const TWO_WINDOW_DAY: ScheduleWindowSpec[] = [
  { startTime: '09:00:00', endTime: '13:00:00' },
  { startTime: '14:00:00', endTime: '18:00:00' },
];

export const FULL_SCALE: SeedConfig = {
  scale: 'full',
  randomSeed: 20260902,
  patients: 120_000,
  // 18 months of history gives the analytics query something to discriminate
  // on; 6 months of future gives the demo bookable and cancellable slots.
  monthsPast: 18,
  monthsFuture: 6,
  cancelledFraction: 0.15,
  rebookedFraction: 0.1,
  waitingListSourceFraction: 0.03,
  blocksPerDoctorPerYear: 10,
  waitingListEntries: 60_000,
  contestedReservoir: 20_000,
  copyChunkRows: 50_000,
  tiers: [
    {
      name: 'popular',
      doctors: 10,
      workingDays: [0, 1, 2, 3, 4, 5],
      windows: [
        { startTime: '08:00:00', endTime: '14:00:00' },
        { startTime: '15:00:00', endTime: '21:00:00' },
      ],
      slotDurationMinutes: 15,
      appointmentsPerDoctor: 24_000,
    },
    {
      name: 'busy',
      doctors: 40,
      workingDays: [0, 1, 2, 3, 4],
      windows: TWO_WINDOW_DAY,
      slotDurationMinutes: 15,
      appointmentsPerDoctor: 13_500,
    },
    {
      name: 'regular',
      doctors: 90,
      workingDays: [0, 1, 2, 3, 4],
      windows: TWO_WINDOW_DAY,
      slotDurationMinutes: 15,
      appointmentsPerDoctor: 11_000,
    },
    {
      name: 'quiet',
      doctors: 60,
      workingDays: [0, 1, 2, 3, 4],
      windows: [
        { startTime: '10:00:00', endTime: '13:00:00' },
        { startTime: '14:00:00', endTime: '17:00:00' },
      ],
      slotDurationMinutes: 30,
      appointmentsPerDoctor: 3_833,
    },
  ],
};

/**
 * About 1% of the data, loads in seconds.
 *
 * Used while iterating on the generators and while recording the screen demo —
 * a fifteen-minute seed on camera is fifteen minutes of dead air.
 */
export const SMALL_SCALE: SeedConfig = {
  ...FULL_SCALE,
  scale: 'small',
  patients: 2_000,
  waitingListEntries: 500,
  contestedReservoir: 1_000,
  copyChunkRows: 10_000,
  tiers: FULL_SCALE.tiers.map((tier) => ({
    ...tier,
    doctors: Math.max(2, Math.round(tier.doctors / 10)),
    appointmentsPerDoctor: Math.round(tier.appointmentsPerDoctor / 100),
  })),
};

export function resolveScale(argv: string[]): SeedConfig {
  return argv.includes('--scale=small') ? SMALL_SCALE : FULL_SCALE;
}
