#!/usr/bin/env node
/**
 * verify-pnpm-injection — assert `injectWorkspacePackages: true` in
 * pnpm-workspace.yaml so the dogfood discovery walker finds bundled check packs.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKSPACE = join(REPO_ROOT, 'pnpm-workspace.yaml');

const log = (msg) => console.error(`[verify-pnpm-injection] ${msg}`);

function main() {
  const text = readFileSync(WORKSPACE, 'utf8');
  const match = text.match(/^injectWorkspacePackages:\s*(\S+)/m);
  if (!match) {
    log('MISSING injectWorkspacePackages in pnpm-workspace.yaml');
    process.exit(1);
  }
  if (match[1] !== 'true') {
    log(`injectWorkspacePackages must be true (found: ${match[1]})`);
    process.exit(1);
  }
  log('injectWorkspacePackages: true');
}

main();
