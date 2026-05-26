/**
 * @fileoverview Unit tests for `readConfigSchemaVersion` + `checkSchemaCompat`.
 *
 * Reader must be PERMISSIVE: every "couldn't determine" case (missing
 * file, malformed YAML, missing field, non-integer, < 1) treated as v1.
 *
 * Classifier must produce the THREE distinct outcomes (ok/older/cli-too-old)
 * with the correct direction — `cli-too-old` for config newer than CLI
 * (user upgrades CLI), `older` for config older than CLI (future migrate).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CLI_SUPPORTED_SCHEMA_VERSION,
  checkSchemaCompat,
  readConfigSchemaVersion,
} from '../config-version.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-config-version-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('readConfigSchemaVersion (permissive)', () => {
  it('returns 1 when the file does not exist', () => {
    expect(readConfigSchemaVersion(join(testDir, 'nope.yml'))).toBe(1);
  });

  it('returns 1 when the YAML is malformed', () => {
    const p = join(testDir, 'bad.yml');
    writeFileSync(p, ':\n:\n!!{not yaml}', 'utf8');
    expect(readConfigSchemaVersion(p)).toBe(1);
  });

  it('returns 1 when the YAML root is not an object', () => {
    const p = join(testDir, 'array.yml');
    writeFileSync(p, '- one\n- two\n', 'utf8');
    expect(readConfigSchemaVersion(p)).toBe(1);
  });

  it('returns 1 when the field is absent', () => {
    const p = join(testDir, 'no-field.yml');
    writeFileSync(p, 'targets: {}\n', 'utf8');
    expect(readConfigSchemaVersion(p)).toBe(1);
  });

  it('returns 1 when the field is a string (non-integer)', () => {
    const p = join(testDir, 'string.yml');
    writeFileSync(p, 'schemaVersion: "1"\n', 'utf8');
    expect(readConfigSchemaVersion(p)).toBe(1);
  });

  it('returns 1 when the field is a float (non-integer)', () => {
    const p = join(testDir, 'float.yml');
    writeFileSync(p, 'schemaVersion: 1.5\n', 'utf8');
    expect(readConfigSchemaVersion(p)).toBe(1);
  });

  it('returns 1 when the field is < 1', () => {
    const p = join(testDir, 'zero.yml');
    writeFileSync(p, 'schemaVersion: 0\n', 'utf8');
    expect(readConfigSchemaVersion(p)).toBe(1);
  });

  it('returns the field when valid', () => {
    const p1 = join(testDir, 'v1.yml');
    writeFileSync(p1, 'schemaVersion: 1\n', 'utf8');
    expect(readConfigSchemaVersion(p1)).toBe(1);

    const p2 = join(testDir, 'v2.yml');
    writeFileSync(p2, 'schemaVersion: 2\n', 'utf8');
    expect(readConfigSchemaVersion(p2)).toBe(2);

    const p99 = join(testDir, 'v99.yml');
    writeFileSync(p99, 'schemaVersion: 99\n', 'utf8');
    expect(readConfigSchemaVersion(p99)).toBe(99);
  });
});

describe('checkSchemaCompat (direction-correct)', () => {
  it('matches → ok', () => {
    const r = checkSchemaCompat(CLI_SUPPORTED_SCHEMA_VERSION);
    expect(r.kind).toBe('ok');
    expect(r.configVersion).toBe(CLI_SUPPORTED_SCHEMA_VERSION);
  });

  it('config newer than CLI → cli-too-old (USER UPGRADES CLI, not migrate)', () => {
    const r = checkSchemaCompat(99);
    expect(r.kind).toBe('cli-too-old');
    if (r.kind === 'cli-too-old') {
      expect(r.configVersion).toBe(99);
      expect(r.cliVersion).toBe(CLI_SUPPORTED_SCHEMA_VERSION);
    }
  });

  it('config older than CLI → older (defensive; future migrate)', () => {
    const r = checkSchemaCompat(0);
    expect(r.kind).toBe('older');
    if (r.kind === 'older') {
      expect(r.configVersion).toBe(0);
      expect(r.cliVersion).toBe(CLI_SUPPORTED_SCHEMA_VERSION);
    }
  });
});
