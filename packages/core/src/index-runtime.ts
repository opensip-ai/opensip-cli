// Runtime — live-run progress transport seam (ADR-0016). Generic over the event
// type so the kernel never names cli-ui's concrete ProgressEvent.
export { createInProcessTransport } from './runtime/in-process-transport.js';
export {
  createSubprocessProgressRun,
  runOffThreadOrInProcess,
} from './runtime/subprocess-transport.js';
export type {
  ProgressTransport,
  ProgressRun,
  ProgressJob,
  SubprocessJobDescriptor,
  WorkerMessage,
} from './runtime/progress-transport.js';