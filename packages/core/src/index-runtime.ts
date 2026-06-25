// Runtime — live-run progress transport seam (ADR-0016). Generic over the event
// type so the kernel never names cli-ui's concrete ProgressEvent.
export { createInProcessTransport } from './runtime/in-process-transport.js';
export {
  createSubprocessProgressRun,
  runOffThreadOrInProcess,
} from './runtime/subprocess-transport.js';
export { forkAndSettle } from './runtime/fork-and-settle.js';
export type {
  ForkAndSettleDescriptor,
  ForkAndSettleHandle,
  ForkEnvContext,
} from './runtime/fork-and-settle.js';
export { killTree } from './runtime/kill-tree.js';
export {
  getWorkerLimits,
  workerExecArgv,
  workerLimitsEnv,
  WORKER_LIMITS_ENV_SPECS,
} from './runtime/worker-limits.js';
export type { WorkerLimits } from './runtime/worker-limits.js';
export { measureIpcPayloadBytes, isIpcPayloadTooLarge } from './runtime/ipc-payload.js';
export { sendWorkerIpcMessage, IpcPayloadTooLargeError } from './runtime/worker-ipc-send.js';
export {
  assertCapturedOutputFits,
  CapturedOutputTooLargeError,
} from './runtime/result-accumulator-cap.js';
export { startWorkerHeartbeat } from './runtime/worker-heartbeat.js';
export type { WorkerHeartbeatMessage, WorkerHeartbeatOptions } from './runtime/worker-heartbeat.js';
export type {
  ProgressTransport,
  ProgressRun,
  ProgressJob,
  SubprocessJobDescriptor,
  WorkerMessage,
} from './runtime/progress-transport.js';
