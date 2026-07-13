import { readFileSync } from 'node:fs';

/**
 * Read the harness version from its package manifest.
 *
 * @throws {Error} When the manifest cannot be read or parsed, or has no string version.
 */
function readAgentEvalVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string'
  ) {
    throw new TypeError('@opensip-cli/agent-eval package.json must contain a string version');
  }
  return manifest.version;
}

/** Version of the workspace-private agent evaluation harness. */
export const AGENT_EVAL_VERSION = readAgentEvalVersion();
