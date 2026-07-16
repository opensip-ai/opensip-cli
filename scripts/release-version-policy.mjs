#!/usr/bin/env node
/** Small workflow adapter around the pure stable-release SemVer policy. */

import { readFileSync } from 'node:fs';

import {
  assertStableUpgrade,
  classifyNpmPackageHttpStatus,
  normalizeStableReleaseVersion,
  parseReleaseVersion,
  selectNewestPriorStableRelease,
} from './lib/release-version-policy.mjs';

export function runReleaseVersionPolicy(argv, input = '') {
  const [command, ...values] = argv;
  if (command === 'normalize-stable' && (values.length === 1 || values.length === 2)) {
    const allowV = values[1] === '--allow-v';
    if (values.length === 2 && !allowV) throw new Error('unknown normalize-stable option');
    return `${normalizeStableReleaseVersion(values[0], { allowV })}\n`;
  }
  if (command === 'assert-upgrade' && values.length === 2) {
    const result = assertStableUpgrade(values[0], values[1]);
    return `${result.previous}\n`;
  }
  if (command === 'classify-npm-status' && values.length === 1) {
    return `${classifyNpmPackageHttpStatus(values[0])}\n`;
  }
  if (command === 'select-prior-stable' && values.length === 1) {
    const tags = input.split(/\r?\n/u).filter((tag) => tag.length > 0);
    const selected = selectNewestPriorStableRelease(values[0], tags);
    return selected === null ? '' : `${selected}\n`;
  }
  if (command === 'select-prior-stable-json' && values.length === 1) {
    const parsed = JSON.parse(input);
    const versions = Array.isArray(parsed) ? parsed : [parsed];
    const stableVersions = versions.filter((version) => {
      const candidate = parseReleaseVersion(version);
      return candidate.prerelease.length === 0;
    });
    const selected = selectNewestPriorStableRelease(values[0], stableVersions);
    return selected === null ? '' : `${selected}\n`;
  }
  throw new Error(
    'usage: release-version-policy <normalize-stable|assert-upgrade|classify-npm-status|select-prior-stable|select-prior-stable-json>',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const input = process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
    process.stdout.write(runReleaseVersionPolicy(process.argv.slice(2), input));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'release version policy failed');
    process.exitCode = 1;
  }
}
