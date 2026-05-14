/**
 * configure command — set up OpenSIP Cloud API key
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

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

// ---------------------------------------------------------------------------
// executeConfigure
// ---------------------------------------------------------------------------

export async function executeConfigure(): Promise<void> {
  const existing = readGlobalConfig();

  if (existing.apiKey) {
    const masked = existing.apiKey.slice(0, 4) + '...' + existing.apiKey.slice(-4);
    console.log(`Current API key: ${masked}`);
  }

  const key = await prompt('Enter your OpenSIP Cloud API key: ');

  if (!key) {
    console.log('No key provided. Configuration unchanged.');
    return;
  }

  existing.apiKey = key;
  writeGlobalConfig(existing);

  console.log(`API key saved to ${CONFIG_PATH}`);
  console.log('You can now use --report-to to send results to OpenSIP Cloud.');
}
