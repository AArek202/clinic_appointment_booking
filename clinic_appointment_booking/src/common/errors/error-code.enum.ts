/**
 * Machine-readable error codes returned alongside the HTTP status.
 *
 * Several distinct conditions share status 409, so tests and the concurrency
 * script assert on these codes rather than on message text.
 * Contract documented in docs/API.md.
 */
export enum ErrorCode {
  SlotAlreadyBooked = 'SLOT_ALREADY_BOOKED',
  PatientAlreadyBooked = 'PATIENT_ALREADY_BOOKED',
  SlotNotOnGrid = 'SLOT_NOT_ON_GRID',
  SlotOutsideSchedule = 'SLOT_OUTSIDE_SCHEDULE',
  SlotBlocked = 'SLOT_BLOCKED',
  CancellationWindowPassed = 'CANCELLATION_WINDOW_PASSED',
  AlreadyInWaitingList = 'ALREADY_IN_WAITING_LIST',
  SlotIsAvailable = 'SLOT_IS_AVAILABLE',
  DateRangeTooLarge = 'DATE_RANGE_TOO_LARGE',
  NotAppointmentOwner = 'NOT_APPOINTMENT_OWNER',
  ScheduleOverlap = 'SCHEDULE_OVERLAP',
  BlockOverlap = 'BLOCK_OVERLAP',
  ValidationFailed = 'VALIDATION_FAILED',
  Unauthorized = 'UNAUTHORIZED',
  Forbidden = 'FORBIDDEN',
  NotFound = 'NOT_FOUND',
  InternalError = 'INTERNAL_ERROR',
  EmailAlreadyRegistered = 'EMAIL_ALREADY_REGISTERED',
}
