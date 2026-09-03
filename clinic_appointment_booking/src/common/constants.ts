/**
 * Business constants shared across features.
 *
 * The whole file is created here because `docs/PLANS/00-interfaces.md` fixes
 * this path and these three names as one unit. Only ALLOWED_SLOT_DURATIONS is
 * used by this plan; CANCELLATION_WINDOW_HOURS is used by Plan 5's cancellation
 * rule and REMINDER_LEAD_HOURS by Plan 6's reminder scheduling.
 */
export const CANCELLATION_WINDOW_HOURS = 2;
export const REMINDER_LEAD_HOURS = 24;
export const ALLOWED_SLOT_DURATIONS = [15, 30, 60] as const;
