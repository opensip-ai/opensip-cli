/**
 * CapturedStderr — size-capped ring buffer for forked worker stderr (DD8).
 */

/** Append-only ring buffer that retains only the trailing `maxBytes`. */
export class CapturedStderr {
  private buf = Buffer.alloc(0);

  constructor(private readonly maxBytes: number) {}

  /** Drain a stderr chunk into the capped buffer. */
  append(chunk: Buffer | string): void {
    const next = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    if (next.length === 0) return;
    const combined = Buffer.concat([this.buf, next]);
    if (combined.length <= this.maxBytes) {
      this.buf = combined;
      return;
    }
    this.buf = combined.subarray(combined.length - this.maxBytes);
  }

  /** Truncated stderr tail for operator triage on worker fault. */
  tail(): string {
    return this.buf.toString('utf8');
  }
}
