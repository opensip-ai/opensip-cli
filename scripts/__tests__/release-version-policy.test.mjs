import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertStableUpgrade,
  classifyNpmPackageHttpStatus,
  compareReleaseVersions,
  normalizeStableReleaseVersion,
  parseReleaseVersion,
  selectNewestPriorStableRelease,
} from '../lib/release-version-policy.mjs';
import { runReleaseVersionPolicy } from '../release-version-policy.mjs';

test('parses exact SemVer and rejects tags, ranges, whitespace, and leading-zero prerelease ids', () => {
  assert.equal(parseReleaseVersion('1.2.3-alpha.1+build.7').normalized, '1.2.3-alpha.1+build.7');
  assert.equal(parseReleaseVersion('v1.2.3', { allowV: true }).normalized, '1.2.3');
  for (const value of ['latest', '^1.2.3', 'v1.2.3', ' 1.2.3', '1.2.3-01']) {
    assert.throws(() => parseReleaseVersion(value));
  }
});

test('compares exact versions with SemVer precedence and ignores build metadata', () => {
  const ordered = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '2.0.0',
  ];
  for (let index = 1; index < ordered.length; index += 1) {
    assert.equal(compareReleaseVersions(ordered[index - 1], ordered[index]), -1);
    assert.equal(compareReleaseVersions(ordered[index], ordered[index - 1]), 1);
  }
  assert.equal(compareReleaseVersions('1.2.3+one', '1.2.3+two'), 0);
});

test('stable latest policy requires a strict forward upgrade', () => {
  assert.equal(normalizeStableReleaseVersion('v2.0.0+build', { allowV: true }), '2.0.0+build');
  assert.deepEqual(assertStableUpgrade('2.0.0', '1.99.99'), {
    candidate: '2.0.0',
    previous: '1.99.99',
  });
  for (const [candidate, previous] of [
    ['1.2.3', '1.2.3'],
    ['1.2.2', '1.2.3'],
    ['2.0.0-rc.1', '1.9.9'],
  ]) {
    assert.throws(() => assertStableUpgrade(candidate, previous));
  }
});

test('bootstrap package absence requires an authoritative npm 404; outages fail closed', () => {
  assert.equal(classifyNpmPackageHttpStatus(200), 'present');
  assert.equal(classifyNpmPackageHttpStatus('404'), 'absent');
  for (const outage of [0, 401, 403, 429, 500, 503, 'not-a-status']) {
    assert.throws(() => classifyNpmPackageHttpStatus(outage));
    assert.throws(() => runReleaseVersionPolicy(['classify-npm-status', String(outage)]));
  }
});

test('recovery selects the newest stable release excluding the candidate', () => {
  assert.equal(
    selectNewestPriorStableRelease('2.0.0', ['v1.0.0', 'v2.0.0', 'v1.12.0', 'v1.9.9']),
    '1.12.0',
  );
  assert.equal(selectNewestPriorStableRelease('1.0.0', ['v1.0.0']), null);
  assert.throws(() => selectNewestPriorStableRelease('2.0.0', ['not-semver']));
  assert.throws(() => selectNewestPriorStableRelease('2.0.0', ['v1.0.0+first', 'v1.0.0+second']));
});

test('workflow adapter normalizes, checks order, and selects from newline-delimited tags', () => {
  assert.equal(runReleaseVersionPolicy(['normalize-stable', 'v2.0.0', '--allow-v']), '2.0.0\n');
  assert.equal(runReleaseVersionPolicy(['assert-upgrade', '2.0.0', '1.9.9']), '1.9.9\n');
  assert.equal(runReleaseVersionPolicy(['classify-npm-status', '404']), 'absent\n');
  assert.equal(
    runReleaseVersionPolicy(
      ['select-prior-stable', '2.0.0'],
      ['v1.2.0', 'v2.0.0', 'v1.10.0'].join('\n'),
    ),
    '1.10.0\n',
  );
  assert.equal(
    runReleaseVersionPolicy(
      ['select-prior-stable-json', '2.0.0'],
      JSON.stringify(['1.10.0', '2.0.0', '3.0.0-rc.1', '1.9.0']),
    ),
    '1.10.0\n',
  );
});
