/**
 * configure command — set up OpenSIP Cloud API key.
 *
 * Prompts via `readline` (Ink can't own a prompt loop without raw mode);
 * banners and result lines route through Ink via the `configure-done`
 * `CommandResult`. No `console.log` and no raw ANSI escapes here.
 *
 * The actual config I/O (read/write `~/.opensip-tools/config.yml`,
 * resolve the API key from flag → env → config) lives in
 * `bootstrap/global-config.ts` so the pre-action hook can call it
 * without inverting the startup → command direction. This file is the
 * prompt+UX wrapper around those primitives. Audit 2026-05-23 M3.
 */

import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { resolveUserPaths } from '@opensip-tools/core';
import { checkEntitlement, DEFAULT_CLOUD_ENDPOINT } from '@opensip-tools/reporting';

import {
  GLOBAL_CONFIG_PATH,
  readGlobalConfig,
  writeGlobalConfig,
} from '../bootstrap/global-config.js';

import type { ConfigureDoneResult } from '@opensip-tools/contracts';

// Re-export `resolveApiKey` from the bootstrap module so existing
// command-side imports (and tests) can continue to consume it through
// the same name without reaching into bootstrap directly.
export { resolveApiKey } from '../bootstrap/global-config.js';

// ---------------------------------------------------------------------------
// Interactive prompt
// ---------------------------------------------------------------------------

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function maskKey(key: string): string {
  if (key.length <= 8) return key;
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/**
 * Test a freshly-entered key against the cloud entitlement endpoint — the
 * configure flow's documented "test the key" step (audit P2-2). Prints the
 * outcome; best-effort, never throws (checkEntitlement returns `entitled:
 * false` on an invalid key, an unreachable endpoint, or a non-entitled plan).
 * The key is saved regardless, so offline setup still works. Returns whether
 * the key verified as entitled.
 */
export async function verifyConfiguredKey(key: string): Promise<boolean> {
  process.stdout.write('Verifying key with OpenSIP Cloud...\n');
  const { entitled } = await checkEntitlement({
    apiKey: key,
    endpoint: DEFAULT_CLOUD_ENDPOINT,
    now: Date.now(),
    cacheDir: join(resolveUserPaths().userHomeDir, 'cache'),
  });
  process.stdout.write(
    entitled
      ? '✓ API key verified — entitled to OpenSIP Cloud storage.\n'
      : '⚠ Could not verify the key (invalid, not entitled, or cloud unreachable).\n' +
          '  Saved anyway; cloud sync will retry on your next run.\n',
  );
  return entitled;
}

// ---------------------------------------------------------------------------
// executeConfigure
// ---------------------------------------------------------------------------

/**
 * Run the interactive configure flow. Returns a `ConfigureDoneResult`;
 * the caller renders it through Ink, including any "current key" hint
 * the user saw at the prompt.
 */
export async function executeConfigure(): Promise<ConfigureDoneResult> {
  const existing = readGlobalConfig();

  if (existing.apiKey) {
    // Pre-prompt informational line. Plain text only — Ink renders the
    // outcome line. We emit this here because the prompt and the
    // current-key hint share the same readline session UX.
    process.stdout.write(`Current API key: ${maskKey(existing.apiKey)}\n`);
  }

  const key = await prompt('Enter your OpenSIP Cloud API key: ');
  if (!key) {
    return { type: 'configure-done', action: 'cancelled', configPath: GLOBAL_CONFIG_PATH };
  }

  existing.apiKey = key;
  writeGlobalConfig(existing);

  // Test the key against the cloud entitlement endpoint (documented step 4).
  await verifyConfiguredKey(key);

  return {
    type: 'configure-done',
    action: 'saved',
    configPath: GLOBAL_CONFIG_PATH,
    maskedKey: maskKey(key),
  };
}
