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

import { createInterface } from 'node:readline';

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

  return {
    type: 'configure-done',
    action: 'saved',
    configPath: GLOBAL_CONFIG_PATH,
    maskedKey: maskKey(key),
  };
}
