#!/usr/bin/env node
/**
 * verify-raw-stream-inventory — committed budget for bundled tool command
 * shells declaring `output: 'raw-stream'`. Every entry must carry
 * `rawStreamReason`.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUDGET = 24;

const RAW_STREAM_REASONS = [
  'completion-script',
  'file-export',
  'worker-ipc',
  'runtime-render-dispatch',
  'session-replay',
  'diagnostic-gate',
  'mcp-stdio',
];

const log = (msg) => console.error(`[verify-raw-stream-inventory] ${msg}`);

function workspacePackageDirs() {
  const packagesDir = join(REPO_ROOT, 'packages');
  const dirs = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const topLevel = join(packagesDir, entry.name);
    if (existsSync(join(topLevel, 'package.json'))) dirs.push(topLevel);
    for (const child of readdirSync(topLevel, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const nested = join(topLevel, child.name);
      if (existsSync(join(nested, 'package.json'))) dirs.push(nested);
    }
  }
  return dirs;
}

function collectToolPackages() {
  const packages = [];
  for (const dir of workspacePackageDirs()) {
    const pjPath = join(dir, 'package.json');
    const pkg = JSON.parse(readFileSync(pjPath, 'utf8'));
    if (pkg.opensipTools?.kind !== 'tool') continue;
    packages.push({ dir, pkg });
  }
  return packages.sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));
}

function collectRawStreamCommands() {
  const entries = [];
  for (const { pkg } of collectToolPackages()) {
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

  const unknown = entries.filter((e) => !RAW_STREAM_REASONS.includes(e.rawStreamReason));
  if (unknown.length > 0) {
    log('FAIL — raw-stream commands declare unknown rawStreamReason:');
    for (const e of unknown) {
      const path = e.parent ? `${e.parent} ${e.name}` : e.name;
      log(`  ${e.package} ${path} (${e.rawStreamReason})`);
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
