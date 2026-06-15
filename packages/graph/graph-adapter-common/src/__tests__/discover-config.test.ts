/**
 * Config-resolution branch tests for `createDiscover`.
 *
 * The base happy path (collect + dedup + sort + candidate-precedence config)
 * is covered in helpers.test.ts. These tests pin the remaining branches of
 * `resolveConfigPath`:
 *
 *   - an explicit `configPathOverride` that exists → resolved against the
 *     project dir and returned (realpath-normalized);
 *   - an explicit override that does NOT exist → still returned (as the
 *     absolute path) so callers see the path they asked for;
 *   - no override and no candidate present → `configPathAbs` omitted entirely
 *     from DiscoverOutput.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDiscover } from '../discover.js';

describe('createDiscover — config resolution branches', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gac-disc-cfg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const discover = createDiscover({
    extension: 'go',
    excludedDirGlobs: ['**/vendor/**'],
    configCandidates: ['go.sum', 'go.mod'],
    languageId: 'go',
  });

  it('uses an explicit configPathOverride that exists (realpath-normalized)', () => {
    writeFileSync(join(dir, 'a.go'), 'package x\n', 'utf8');
    // Override points at a file that is NOT one of the candidates.
    const override = 'custom.config';
    writeFileSync(join(dir, override), 'k=v\n', 'utf8');

    const out = discover({ cwd: dir, configPathOverride: override });

    // Resolved against the project dir and realpath-normalized.
    expect(out.configPathAbs).toBe(realpathSync(resolve(dir, override)));
  });

  it('returns the absolute override path even when the override file is missing', () => {
    writeFileSync(join(dir, 'a.go'), 'package x\n', 'utf8');
    const override = 'does-not-exist.config';

    const out = discover({ cwd: dir, configPathOverride: override });

    // Not realpath-able (missing), so the bare resolved absolute path comes
    // back — resolved against the realpath-normalized project dir.
    expect(out.configPathAbs).toBe(resolve(realpathSync(dir), override));
  });

  it('omits configPathAbs when no override and no candidate exists', () => {
    writeFileSync(join(dir, 'a.go'), 'package x\n', 'utf8');
    // No go.sum / go.mod written.

    const out = discover({ cwd: dir });

    expect(out.configPathAbs).toBeUndefined();
    expect('configPathAbs' in out).toBe(false);
    expect(out.files).toHaveLength(1);
  });

  it('treats an empty-string override as "no override" and falls back to candidates', () => {
    writeFileSync(join(dir, 'a.go'), 'package x\n', 'utf8');
    writeFileSync(join(dir, 'go.mod'), 'module x\n', 'utf8');

    const out = discover({ cwd: dir, configPathOverride: '' });

    // Empty override is ignored; candidate precedence picks go.mod.
    expect(out.configPathAbs).toBe(realpathSync(resolve(dir, 'go.mod')));
  });
});
