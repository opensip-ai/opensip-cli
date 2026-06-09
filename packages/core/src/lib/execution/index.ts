/**
 * Execution substrate (north-star §5.8, release 2.13.0) — one bounded scheduler +
 * per-unit timeout/retry that fit + sim recipes run on, so `timeout`/`maxParallel`/
 * `stopOnFirstFailure` mean the same thing in every domain.
 */

export { scheduleUnits, yieldToEventLoop } from './schedule.js';
export type { ScheduleUnitsOptions } from './schedule.js';

export { runWithTimeout } from './run-with-timeout.js';
export type { UnitRunOutcome, RunWithTimeoutOptions } from './run-with-timeout.js';

export { runWithRetry } from './retry.js';
export type { PipelineRetryOptions, PipelineRetryOutcome } from './retry.js';

export { executePipeline } from './pipeline.js';
export type { ExecutePipelineOptions } from './pipeline.js';

export type { WorkflowExecutionOptions, WorkflowRetryOptions } from './options.js';
