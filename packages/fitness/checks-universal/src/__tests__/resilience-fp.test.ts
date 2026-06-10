/**
 * @fileoverview FP-regression suite for two resilience checks.
 *
 * - exit-code-correctness: a catch block that propagates failure via a numeric
 *   `cli.setExitCode(1)` (the CLI-dispatcher pattern) must NOT be flagged as a
 *   silent exit-0. Only the named-constant form was recognized before.
 * - unbounded-memory: a `JSON.parse(readFileSync(...))` structured-doc load and
 *   a module-self-relative committed-asset read are bounded by nature and must
 *   NOT be flagged as OOM risks.
 *
 * Each case also pins that genuine positives still fire.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { fileCache } from '@opensip-tools/fitness';
import { afterEach, describe, expect, it } from 'vitest';

import { checks } from '../index.js';

function findCheck(slug: string) {
  const check = checks.find((c) => c.config.slug === slug);
  if (!check) throw new Error(`check not found: ${slug}`);
  return check;
}

function writeFixture(cwd: string, rel: string, content: string): string {
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

afterEach(() => fileCache.clear());

describe('exit-code-correctness — numeric setExitCode FP regression', () => {
  it('does NOT flag a catch that calls cli.setExitCode(1)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cu-fp-exit-'));
    const file = writeFixture(
      cwd,
      'src/cli/worker.ts',
      [
        'export function run(cli: any, path: string): void {',
        '  try {',
        '    doWork(path);',
        '    cli.setExitCode(0);',
        '  } catch (error) {',
        '    logger.error({ err: String(error) });',
        '    cli.setExitCode(1);',
        '  }',
        '}',
      ].join('\n'),
    );
    const result = await findCheck('exit-code-correctness').run(cwd, { targetFiles: [file] });
    expect(result.signals).toHaveLength(0);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('STILL flags a catch that logs and silently continues', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cu-fp-exit2-'));
    const file = writeFixture(
      cwd,
      'src/cli/silent.ts',
      [
        'export function run(path: string): void {',
        '  try {',
        '    doWork(path);',
        '  } catch (error) {',
        '    logger.error({ err: String(error) });',
        '  }',
        '}',
      ].join('\n'),
    );
    const result = await findCheck('exit-code-correctness').run(cwd, { targetFiles: [file] });
    expect(result.signals.length).toBeGreaterThan(0);
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe('unbounded-memory — bounded-read FP regression', () => {
  it('does NOT flag JSON.parse(readFileSync(...)) structured-doc loads', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cu-fp-mem1-'));
    const file = writeFixture(
      cwd,
      'src/worker.ts',
      [
        'import { readFileSync } from "node:fs";',
        'export function load(specPath: string) {',
        '  const spec = JSON.parse(readFileSync(specPath, "utf8"));',
        '  return spec;',
        '}',
      ].join('\n'),
    );
    const result = await findCheck('unbounded-memory').run(cwd, { targetFiles: [file] });
    expect(result.signals).toHaveLength(0);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('does NOT flag a module-self-relative committed-asset read', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cu-fp-mem2-'));
    const file = writeFixture(
      cwd,
      'src/vendor-read.ts',
      [
        'import { readFileSync } from "node:fs";',
        'import { dirname, join } from "node:path";',
        'import { fileURLToPath } from "node:url";',
        'const HERE = dirname(fileURLToPath(import.meta.url));',
        'export function bundle(): string {',
        '  const candidate = join(HERE, "..", "vendor", "bundle.js");',
        '  return readFileSync(candidate, "utf8");',
        '}',
      ].join('\n'),
    );
    const result = await findCheck('unbounded-memory').run(cwd, { targetFiles: [file] });
    expect(result.signals).toHaveLength(0);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('STILL flags an unguarded read of an external path', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cu-fp-mem3-'));
    const file = writeFixture(
      cwd,
      'src/upload.ts',
      [
        'import { readFileSync } from "node:fs";',
        'export function ingest(userPath: string): string {',
        '  const raw = readFileSync(userPath, "utf8");',
        '  return raw.toUpperCase();',
        '}',
      ].join('\n'),
    );
    const result = await findCheck('unbounded-memory').run(cwd, { targetFiles: [file] });
    expect(result.signals.length).toBeGreaterThan(0);
    rmSync(cwd, { recursive: true, force: true });
  });
});
