// ADR-0054 M4-G clean fixture: the discovery file is the worker-owned plane, so
// it may pass the WORKER policy (the import runs only inside the dispatch worker,
// gated by isHostRuntimeImportForbidden). Bundled host imports use the bundled
// host policy. Neither is a violation.
import {
  hostRuntimeImportPolicyFor,
  importToolRuntime,
  workerRuntimeImportPolicyFor,
} from './admit-tool-package.js';

export async function loadBundledInHost(dir: string): Promise<unknown> {
  return importToolRuntime(dir, hostRuntimeImportPolicyFor('bundled'));
}

export async function loadExternalInWorker(dir: string, source: ToolSource): Promise<unknown> {
  return importToolRuntime(dir, workerRuntimeImportPolicyFor(source));
}
