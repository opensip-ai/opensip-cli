// ADR-0054 M4-G violation fixture: importToolRuntime called OUTSIDE the
// admission/discovery boundary (a command module). External runtimes must never
// import in the host — this is the canonical out-of-boundary host import.
import { importToolRuntime, workerRuntimeImportPolicyFor } from '../bootstrap/admit-tool-package.js';

export async function loadTool(dir: string): Promise<unknown> {
  return importToolRuntime(dir, workerRuntimeImportPolicyFor('installed'));
}
