export { makeTestScope, withScope, withScopeSync } from './scope.js';
export {
  createToolCliContextDouble,
  runCommandSpec,
  type CapturedArtifactWrite,
  type CapturedBaselineCompare,
  type CapturedBaselineExport,
  type CapturedDelivery,
  type CapturedEmitError,
  type CapturedLogEntry,
  type CommandSpecRunResult,
  type ToolCliContextCaptured,
  type ToolCliContextDouble,
  type ToolCliContextDoubleOptions,
} from './context-double.js';
export {
  assertCommandResult,
  assertReportFailureDetail,
  assertSignalEnvelope,
} from './assertions.js';
