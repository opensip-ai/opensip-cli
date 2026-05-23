/**
 * configure command — set up OpenSIP Cloud API key.
 *
 * Prompts via `readline` (Ink can't own a prompt loop without raw mode);
 * banners and result lines route through Ink via the `configure-done`
 * `CommandResult`. No `console.log` and no raw ANSI escapes here.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { ConfigureDoneResult } from '@opensip-tools/contracts';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const OPENSIP_DIR = join(homedir(), '.opensip-tools');
const CONFIG_PATH = join(OPENSIP_DIR, 'config.yml');

// ---------------------------------------------------------------------------
// Read existing global config
// ---------------------------------------------------------------------------

interface GlobalConfig {
  apiKey?: string;
  [key: string]: unknown;
}

function readGlobalConfig(): GlobalConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    return (parseYaml(raw) as GlobalConfig) ?? {};
  } catch {
    return {};
  }
}

function writeGlobalConfig(config: GlobalConfig): void {
  if (!existsSync(OPENSIP_DIR)) {
    mkdirSync(OPENSIP_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, stringifyYaml(config), 'utf8');
  chmodSync(CONFIG_PATH, 0o600);
}

// ---------------------------------------------------------------------------
// Resolve API key from multiple sources (CLI flag > env > global config)
// ---------------------------------------------------------------------------

export function resolveApiKey(cliFlag?: string): string | undefined {
  if (cliFlag) return cliFlag;
  if (process.env.OPENSIP_API_KEY) return process.env.OPENSIP_API_KEY;
  const config = readGlobalConfig();
  return config.apiKey ?? undefined;
}

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
    return { type: 'configure-done', action: 'cancelled', configPath: CONFIG_PATH };
  }

  existing.apiKey = key;
  writeGlobalConfig(existing);

  return {
    type: 'configure-done',
    action: 'saved',
    configPath: CONFIG_PATH,
    maskedKey: maskKey(key),
  };
}
