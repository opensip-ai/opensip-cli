#!/usr/bin/env node
/**
 * verify-release-publish-surface — given a release version, assert every
 * package in scripts/release-package-order.mjs resolves on the npm registry.
 *
 * Usage:
 *   node scripts/verify-release-publish-surface.mjs --expected-version v0.1.8
 *   node scripts/verify-release-publish-surface.mjs --expected-version 0.1.8 --tag latest
 *
 * Exit 0 when every expected name@version is present under the requested dist-tag;
 * exit 1 with a list of missing packages otherwise.
 */

import { execFileSync } from 'node:child_process';

function parseArgs(argv) {
  let expectedVersion;
  let tag = 'latest';
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--expected-version') {
      expectedVersion = argv[++i];
      continue;
    }
    if (arg === '--tag') {
      tag = argv[++i];
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(
        `Usage: node scripts/verify-release-publish-surface.mjs --expected-version vX.Y.Z [--tag latest]`,
      );
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!expectedVersion) {
    throw new Error('--expected-version is required');
  }
  const version = expectedVersion.startsWith('v') ? expectedVersion.slice(1) : expectedVersion;
  return { version, tag };
}

function registryName(token) {
  return token === 'opensip-cli' ? 'opensip-cli' : `@opensip-cli/${token}`;
}

function npmView(name, version, tag) {
  try {
    const out = execFileSync(
      'npm',
      ['view', `${name}@${version}`, 'version', 'dist-tags', '--json'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const parsed = JSON.parse(out.trim());
    return parsed?.version === version && parsed?.['dist-tags']?.[tag] === version;
  } catch {
    return false;
  }
}

const { version, tag } = parseArgs(process.argv);
const names = execFileSync('node', ['scripts/release-package-order.mjs', '--print', 'names'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter((line) => line.length > 0);

const missing = [];
for (const token of names) {
  const name = registryName(token);
  if (npmView(name, version, tag)) continue;
  missing.push(name);
}

if (missing.length > 0) {
  console.error(
    `Missing or not tagged '${tag}' on npm for version ${version}:\n` +
      missing.map((n) => `  - ${n}@${version}`).join('\n'),
  );
  process.exit(1);
}

console.log(`All ${names.length} packages resolve as ${version} under dist-tag '${tag}'.`);
