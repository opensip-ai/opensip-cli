import { hostRuntimeImportPolicyFor, importToolRuntime } from './admit-tool-package.js';

export async function loadTool(dir: string): Promise<unknown> {
  return importToolRuntime(dir, hostRuntimeImportPolicyFor('installed'));
}