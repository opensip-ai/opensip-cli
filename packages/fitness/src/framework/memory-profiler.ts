/**
 * @fileoverview Memory profiler for fitness checks
 *
 * Always-on, low-overhead memory tracking for check execution.
 * Collects per-check profiles for trending analysis.
 */

/** Point-in-time snapshot of Node.js memory usage */
export interface MemorySnapshot {
  readonly heapUsed: number
  readonly heapTotal: number
  readonly external: number
  readonly arrayBuffers: number
  readonly rss: number
}

/** Memory usage profile recorded for a single check execution */
export interface CheckMemoryProfile {
  readonly checkId: string
  readonly memoryBeforeMB: number
  readonly memoryAfterMB: number
  readonly memoryDeltaMB: number
  readonly violationCount: number
  readonly durationMs: number
}

/** Aggregated memory profiling summary across all check executions */
export interface MemoryProfileSummary {
  readonly prewarmMemoryMB: number
  readonly peakMemoryMB: number
  readonly checksExceedingThreshold: number
  readonly topConsumers: readonly CheckMemoryProfile[]
  readonly allProfiles: readonly CheckMemoryProfile[]
}

const DEFAULT_MEMORY_WARNING_THRESHOLD_MB = 200

/** Low-overhead memory profiler that tracks per-check heap usage during fitness runs */
export class MemoryProfiler {
  private readonly profiles: CheckMemoryProfile[] = []
  private prewarmMemoryMB = 0
  private peakMemoryMB = 0
  private readonly warningThresholdMB: number

  constructor(warningThresholdMB = DEFAULT_MEMORY_WARNING_THRESHOLD_MB) {
    this.warningThresholdMB = warningThresholdMB
  }

  private takeSnapshot(): MemorySnapshot {
    const mem = process.memoryUsage()
    return {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      rss: mem.rss,
    }
  }

  private bytesToMB(bytes: number): number {
    return bytes / 1024 / 1024
  }

  /** Record memory baseline after cache prewarm completes */
  recordPrewarmComplete(): void {
    const snapshot = this.takeSnapshot()
    this.prewarmMemoryMB = this.bytesToMB(snapshot.heapUsed)
    this.peakMemoryMB = this.prewarmMemoryMB
  }

  /** Return current heap usage in megabytes */
  getCurrentMemoryMB(): number {
    const snapshot = this.takeSnapshot()
    return this.bytesToMB(snapshot.heapUsed)
  }

  /** Record memory before a check starts; returns the pre-check heap in MB */
  recordCheckStart(): number {
    return this.getCurrentMemoryMB()
  }

  /** Record memory after a check completes and return the check's memory profile */
  recordCheckComplete(
    checkId: string,
    memoryBeforeMB: number,
    violationCount: number,
    durationMs: number,
  ): CheckMemoryProfile {
    const memoryAfterMB = this.getCurrentMemoryMB()
    const memoryDeltaMB = memoryAfterMB - memoryBeforeMB

    if (memoryAfterMB > this.peakMemoryMB) {
      this.peakMemoryMB = memoryAfterMB
    }

    const profile: CheckMemoryProfile = {
      checkId,
      memoryBeforeMB: Math.round(memoryBeforeMB * 100) / 100,
      memoryAfterMB: Math.round(memoryAfterMB * 100) / 100,
      memoryDeltaMB: Math.round(memoryDeltaMB * 100) / 100,
      violationCount,
      durationMs,
    }

    this.profiles.push(profile)
    return profile
  }

  /** Check whether a memory delta exceeds the configured warning threshold */
  exceedsThreshold(deltaMB: number): boolean {
    return deltaMB > this.warningThresholdMB
  }

  /** Return the configured warning threshold in megabytes */
  getWarningThresholdMB(): number {
    return this.warningThresholdMB
  }

  /** Build and return an aggregated summary of all recorded check profiles */
  getSummary(): MemoryProfileSummary {
    const sortedProfiles = [...this.profiles].sort((a, b) => b.memoryDeltaMB - a.memoryDeltaMB)

    const checksExceedingThreshold = this.profiles.filter(
      (p) => p.memoryDeltaMB > this.warningThresholdMB,
    ).length

    return {
      prewarmMemoryMB: Math.round(this.prewarmMemoryMB * 100) / 100,
      peakMemoryMB: Math.round(this.peakMemoryMB * 100) / 100,
      checksExceedingThreshold,
      topConsumers: sortedProfiles.slice(0, 10),
      allProfiles: this.profiles,
    }
  }

  /** Reset all recorded profiles and counters */
  reset(): void {
    this.profiles.length = 0
    this.prewarmMemoryMB = 0
    this.peakMemoryMB = 0
  }
}

/** Shared singleton memory profiler instance used across fitness check runs */
export const memoryProfiler = new MemoryProfiler()
