/**
 * @fileoverview Latency tracker for real percentile computation
 *
 * All samples are stored for accurate percentile computation.
 * Sorted cache is invalidated when new samples are added.
 * Percentiles use linear interpolation between nearest values.
 *
 * Suitable for simulation-scale workloads (hundreds to low thousands of samples).
 * For workloads exceeding ~100k samples, consider a streaming percentile
 * algorithm (e.g., t-digest or HDR histogram).
 */

export class LatencyTracker {
  private samples: number[] = []
  private sorted: number[] | null = null
  private sum = 0

  /**
   * Record a latency sample.
   * @param latencyMs - Latency value in milliseconds
   */
  record(latencyMs: number): void {
    this.samples.push(latencyMs)
    this.sum += latencyMs
    this.sorted = null
  }

  /** Get the number of recorded samples. */
  get count(): number {
    return this.samples.length
  }

  /** Get the average latency. */
  get average(): number {
    if (this.samples.length === 0) return 0
    return this.sum / this.samples.length
  }

  /**
   * Compute a percentile value using linear interpolation.
   * @param p - Percentile (0-100), e.g., 50, 95, 99
   * @returns The latency value at the given percentile, or 0 if no samples
   */
  getPercentile(p: number): number {
    if (this.samples.length === 0) return 0
    if (this.samples.length === 1) return this.samples[0] ?? 0

    const sorted = this.getSorted()
    const index = (p / 100) * (sorted.length - 1)
    const lower = Math.floor(index)
    const upper = Math.ceil(index)

    if (lower === upper) return sorted[lower] ?? 0

    const fraction = index - lower
    return (sorted[lower] ?? 0) * (1 - fraction) + (sorted[upper] ?? 0) * fraction
  }

  /**
   * Get a latency snapshot compatible with SimulationMetrics fields.
   */
  getLatencySnapshot(): {
    avgLatencyMs: number
    p50LatencyMs: number
    p95LatencyMs: number
    p99LatencyMs: number
  } {
    return {
      avgLatencyMs: this.average,
      p50LatencyMs: this.getPercentile(50),
      p95LatencyMs: this.getPercentile(95),
      p99LatencyMs: this.getPercentile(99),
    }
  }

  /** Reset all tracked samples. */
  reset(): void {
    this.samples.length = 0
    this.sorted = null
    this.sum = 0
  }

  private getSorted(): number[] {
    this.sorted ??= [...this.samples].sort((a, b) => a - b)
    return this.sorted
  }
}
