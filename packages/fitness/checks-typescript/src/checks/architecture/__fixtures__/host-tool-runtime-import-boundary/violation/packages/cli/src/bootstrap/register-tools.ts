// ADR-0054 M4-G violation fixture: register-tools.ts is an allowlisted CALLSITE
// (it bootstraps the BUNDLED tools), but it is NOT on the worker-owned plane, so
// it must pass a BUNDLED host policy. Passing workerRuntimeImportPolicyFor here
// would import an EXTERNAL runtime in the host — the capstone forbids it.
import { importToolRuntime, workerRuntimeImportPolicyFor } from './admit-tool-package.js';

export async function loadTool(dir: string, source: ToolSource): Promise<unknown> {
  return importToolRuntime(dir, workerRuntimeImportPolicyFor(source));
}
