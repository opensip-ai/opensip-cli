#!/usr/bin/env node
/**
 * verify-raw-stream-inventory — committed budget for bundled tool command
 * shells declaring `output: 'raw-stream'`. Every entry must carry
 * `rawStreamReason`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUDGET = 12;

const BUNDLED_TOOL_DIRS = [
  'packages/fitness/engine',
  'packages/simulation/engine',
  'packages/graph/engine',
  'packages/yagni/engine',
];

const log = (msg) => console.error(`[verify-raw-stream-inventory] ${msg}`);

function collectRawStreamCommands() {
  const entries = [];
  for (const toolDir of BUNDLED_TOOL_DIRS) {
    const pjPath = join(REPO_ROOT, toolDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pjPath, 'utf8'));
    const commands = pkg.opensipTools?.commands ?? [];
    for (const cmd of commands) {
      if (cmd.output !== 'raw-stream') continue;
      entries.push({
        package: pkg.name,
        name: cmd.name,
        parent: cmd.parent,
        rawStreamReason: cmd.rawStreamReason,
      });
    }
  }
  return entries;
}

function main() {
  const entries = collectRawStreamCommands();
  const missing = entries.filter((e) => !e.rawStreamReason);
  if (missing.length > 0) {
    log('FAIL — raw-stream commands missing rawStreamReason:');
    for (const e of missing) {
      const path = e.parent ? `${e.parent} ${e.name}` : e.name;
      log(`  ${e.package} ${path}`);
    }
    process.exit(1);
  }

  if (entries.length > BUDGET) {
    log(`FAIL — raw-stream inventory ${entries.length} > budget ${BUDGET}`);
    for (const e of entries) {
      const path = e.parent ? `${e.parent} ${e.name}` : e.name;
      log(`  ${e.package} ${path} (${e.rawStreamReason})`);
    }
    process.exit(1);
  }

  log(`${entries.length} raw-stream command(s) within budget ${BUDGET}`);
}

main();
