import { randomUUID } from 'node:crypto';
import { UserRole } from '../../../common/enums/role.enum';
import { encodeCopyRow } from '../copy-writer';
import { Rng } from '../random';
import { DoctorTier, SeedConfig, TierName } from '../seed.config';

export const USER_COLUMNS = [
  'id',
  'first_name',
  'last_name',
  'email',
  'password_hash',
  'role',
  'created_at',
  'updated_at',
];

export const DOCTOR_COLUMNS = [
  'id',
  'user_id',
  'specialization',
  'achievements',
];

export const PATIENT_COLUMNS = [
  'id',
  'user_id',
  'phone_number',
  'date_of_birth',
  'gender',
  'has_insurance',
];

export interface SeededDoctor {
  id: string;
  userId: string;
  tier: TierName;
}

export interface GeneratedPeople {
  userRows: string[];
  doctorRows: string[];
  patientRows: string[];
  doctors: SeededDoctor[];
  patientIds: string[];
  adminEmail: string;
}

const SPECIALIZATIONS = [
  'Cardiology',
  'Dermatology',
  'Endocrinology',
  'Family Medicine',
  'Gastroenterology',
  'Neurology',
  'Obstetrics',
  'Ophthalmology',
  'Orthopaedics',
  'Paediatrics',
  'Psychiatry',
  'Pulmonology',
] as const;

const GENDERS = ['female', 'male', 'other'] as const;

const ADMIN_EMAIL = 'admin@clinic.test';

/**
 * All seeded users share one password hash.
 *
 * bcrypt at cost 10 takes 60-100 ms per hash by design. Hashing 120,000
 * distinct passwords would add two to three hours to the seed and demonstrate
 * nothing the auth unit tests do not already cover. One shared hash also means
 * the demo can log in as any seeded account.
 */
export function generatePeople(
  config: SeedConfig,
  rng: Rng,
  passwordHash: string,
  now: Date,
): GeneratedPeople {
  const userRows: string[] = [];
  const doctorRows: string[] = [];
  const patientRows: string[] = [];
  const doctors: SeededDoctor[] = [];
  const patientIds: string[] = [];

  const adminId = randomUUID();
  userRows.push(
    encodeCopyRow([
      adminId,
      'Clinic',
      'Admin',
      ADMIN_EMAIL,
      passwordHash,
      UserRole.Admin,
      now,
      now,
    ]),
  );

  let doctorNumber = 0;
  for (const tier of config.tiers) {
    for (let i = 0; i < tier.doctors; i += 1) {
      doctorNumber += 1;
      const userId = randomUUID();
      const doctorId = randomUUID();

      userRows.push(
        encodeCopyRow([
          userId,
          'Doctor',
          `Number${doctorNumber}`,
          `doctor${doctorNumber}@clinic.test`,
          passwordHash,
          UserRole.Doctor,
          now,
          now,
        ]),
      );
      doctorRows.push(
        encodeCopyRow([
          doctorId,
          userId,
          rng.pick(SPECIALIZATIONS),
          `${rng.int(2, 30)} years of practice`,
        ]),
      );
      doctors.push({ id: doctorId, userId, tier: tier.name });
    }
  }

  for (let i = 1; i <= config.patients; i += 1) {
    const userId = randomUUID();
    const patientId = randomUUID();

    userRows.push(
      encodeCopyRow([
        userId,
        'Patient',
        `Number${i}`,
        `patient${i}@clinic.test`,
        passwordHash,
        UserRole.Patient,
        now,
        now,
      ]),
    );
    patientRows.push(
      encodeCopyRow([
        patientId,
        userId,
        `+2010${String(10_000_000 + i).slice(0, 8)}`,
        `${rng.int(1950, 2008)}-${String(rng.int(1, 12)).padStart(2, '0')}-${String(
          rng.int(1, 28),
        ).padStart(2, '0')}`,
        rng.pick(GENDERS),
        rng.chance(0.45),
      ]),
    );
    patientIds.push(patientId);
  }

  return {
    userRows,
    doctorRows,
    patientRows,
    doctors,
    patientIds,
    adminEmail: ADMIN_EMAIL,
  };
}

export function doctorTierOf(tiers: DoctorTier[], name: TierName): DoctorTier {
  const tier = tiers.find((candidate) => candidate.name === name);
  if (!tier) {
    throw new Error(`Unknown doctor tier: ${name}`);
  }
  return tier;
}
