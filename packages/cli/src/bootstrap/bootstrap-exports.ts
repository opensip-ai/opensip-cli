// Re-export only the symbols the CLI composition root (`index.ts`) consumes.
export { mountAllToolCommands, EXPECTED_SCAFFOLDING_TOOL_IDS } from './register-tools.js';

// The shared admission callable (ADR-0041: one validator, four consumers) —
// consumed by the tools command group (validate/install) and the
// admission-parity / bundled-conformance tests.
export {
  admitToolPackage,
  importToolRuntime,
  type AdmissionReport,
  type AdmissionSection,
  type AdmissionSectionResult,
  type AdmitToolPackageOptions,
} from './admit-tool-package.js';

export { renderResult } from './render.js';
export { maybeOpenReport } from './report.js';
export { installPreActionHook } from './pre-action-hook.js';
export { buildCommandRegistrationInput } from './build-command-registration-input.js';
export { buildHostPlanes } from './host-planes.js';
export { isRootVersionRequest } from './root-version.js';
export { resolveStartupExecutionMode, type ToolRuntimeExecutionMode } from './worker-datastore.js';
