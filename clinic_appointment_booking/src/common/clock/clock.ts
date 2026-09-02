/**
 * Injectable source of the current time.
 *
 * Every time-dependent business rule reads time through this, never through
 * `new Date()`. Without it, the 2-hour cancellation window and the 24-hour
 * reminder offset cannot be tested deterministically.
 */
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock extends Clock {
  constructor(private fixed: Date) {
    super();
  }

  now(): Date {
    return new Date(this.fixed.getTime());
  }

  set(next: Date): void {
    this.fixed = next;
  }
}
