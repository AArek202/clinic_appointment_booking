interface Phase {
  name: string;
  rows: number;
  ms: number;
}

/**
 * Prints where the seed's time actually went.
 *
 * "The seed takes about fifteen minutes" is not a useful claim without knowing
 * which phase owns those minutes, and the README quotes a measured number.
 */
export class PhaseTimer {
  private readonly phases: Phase[] = [];

  async run<T>(
    name: string,
    rows: () => number | Promise<number>,
    work: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    const result = await work();
    this.phases.push({ name, rows: await rows(), ms: Date.now() - startedAt });
    return result;
  }

  report(): string {
    const totalMs = this.phases.reduce((sum, phase) => sum + phase.ms, 0);
    const totalRows = this.phases.reduce((sum, phase) => sum + phase.rows, 0);

    const lines = [
      'phase                       rows        seconds      rows/s',
      '----------------------------------------------------------',
      ...this.phases.map(
        (phase) =>
          `${phase.name.padEnd(24)}${String(phase.rows).padStart(10)}` +
          `${(phase.ms / 1000).toFixed(1).padStart(15)}` +
          `${Math.round(phase.rows / Math.max(phase.ms / 1000, 0.001))
            .toString()
            .padStart(12)}`,
      ),
      '----------------------------------------------------------',
      `${'TOTAL'.padEnd(24)}${String(totalRows).padStart(10)}${(totalMs / 1000).toFixed(1).padStart(15)}`,
    ];

    return lines.join('\n');
  }
}
