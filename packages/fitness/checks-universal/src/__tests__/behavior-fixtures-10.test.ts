// @fitness-ignore-file file-length-limit -- behavior fixture suite; related scenarios stay together while checks are split into focused tests.
/**
 * @fileoverview Branch-behavior tests for medium-coverage checks (round 10).
 *
 * Targets the test-file-naming directory walker, the eslint-justifications
 * inline-suppression validator, and the sentry PII-scrubbing detector.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { fileCache } from '@opensip-cli/fitness';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { checks } from '../index.js';

function findCheck(slug: string) {
  const check = checks.find((c) => c.config.slug === slug);
  if (!check) throw new Error(`check not found: ${slug}`);
  return check;
}

function makeFixtureDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `cu-cov10-${prefix}-`));
}

function writeFixture(cwd: string, rel: string, content: string): string {
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

afterEach(() => fileCache.clear());

// =============================================================================
// test-file-naming: extension variants, nested dirs, and skipped dirs
// =============================================================================

describe('test-file-naming directory walk', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('tfn');
    writeFixture(cwd, 'package.json', JSON.stringify({ name: 'root' }, null, 2));
    // .tsx misnamed file -> exercises isTypeScriptFile tsx branch + violation.
    writeFixture(
      cwd,
      'packages/a/__tests__/widget-checks.tsx',
      ['export const Widget = () => null'].join('\n'),
    );
    // A .d.ts file inside __tests__ -> isDeclarationFile branch -> not a test file.
    writeFixture(cwd, 'packages/a/__tests__/types.d.ts', 'export type T = number');
    // Nested subdirectory under __tests__ with a valid test -> recursion branch.
    writeFixture(
      cwd,
      'packages/a/__tests__/unit/thing.test.ts',
      ['import { it } from "vitest"; it("x", () => undefined)'].join('\n'),
    );
    // An allowlist data module under __tests__ -> IGNORED_PATTERNS branch
    // (test config/data imported by a real *.test.ts; not a test case itself).
    writeFixture(
      cwd,
      'packages/a/__tests__/foo.allowlist.ts',
      ['export const ALLOWLIST = []'].join('\n'),
    );
    // A build-artifact dir under __tests__ -> SKIP_DIRECTORIES branch.
    writeFixture(cwd, 'packages/a/__tests__/dist/bundle.js', 'module.exports = {}');
    // A hidden directory at scan level -> startsWith('.') skip branch.
    writeFixture(cwd, 'packages/a/.cache/junk.ts', 'export const j = 1');
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags a misnamed .tsx test and recurses into nested dirs without throwing', async () => {
    const result = await findCheck('test-file-naming').run(cwd, {
      targetFiles: [
        join(cwd, 'packages/a/__tests__/widget-checks.tsx'),
        join(cwd, 'packages/a/__tests__/types.d.ts'),
        join(cwd, 'packages/a/__tests__/unit/thing.test.ts'),
        join(cwd, 'packages/a/__tests__/foo.allowlist.ts'),
      ],
    });
    const matches = result.signals.map((s) => s.metadata.match);
    // The misnamed .tsx file is flagged; the valid nested test, the
    // .d.ts declaration file, and the .allowlist.ts data module are not.
    expect(matches).toContain('widget-checks.tsx');
    expect(matches).not.toContain('thing.test.ts');
    expect(matches).not.toContain('types.d.ts');
    expect(matches).not.toContain('foo.allowlist.ts');
  });
});

// =============================================================================
// eslint-justifications: missing, too-long, malformed, unclosed-block
// =============================================================================

describe('eslint-justifications inline variants', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('eslint-just');
    // Inline disable-next-line with NO justification -> missing-justification.
    writeFixture(
      cwd,
      'src/missing.ts',
      ['// eslint-disable-next-line no-console', 'console.log(1)'].join('\n'),
    );
    // Free-text after the directive with no `--` separator and embedded
    // spaces -> JUSTIFICATION_PATTERN fails -> malformed.
    writeFixture(
      cwd,
      'src/malformed.ts',
      ['// eslint-disable-next-line because reasons go here', 'console.log(1)'].join('\n'),
    );
    // A well-formed justification -> no issue.
    writeFixture(
      cwd,
      'src/ok.ts',
      [
        '// eslint-disable-next-line no-console -- diagnostic output gated behind a debug flag',
        'console.log(1)',
      ].join('\n'),
    );
    // An unclosed multi-line eslint-disable block with rules on the start
    // line and no closing `*/` or eslint-enable -> unclosed-block violation.
    writeFixture(
      cwd,
      'src/unclosed.ts',
      ['/* eslint-disable no-console', 'doThing()', 'moreCode()'].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags an inline suppression with no justification', async () => {
    const result = await findCheck('eslint-justifications').run(cwd, {
      targetFiles: [join(cwd, 'src/missing.ts')],
    });
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('flags a malformed suppression comment', async () => {
    const result = await findCheck('eslint-justifications').run(cwd, {
      targetFiles: [join(cwd, 'src/malformed.ts')],
    });
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('does not flag a well-formed justification', async () => {
    const result = await findCheck('eslint-justifications').run(cwd, {
      targetFiles: [join(cwd, 'src/ok.ts')],
    });
    expect(result.signals.length).toBe(0);
  });

  it('flags an unclosed multi-line eslint-disable block', async () => {
    const result = await findCheck('eslint-justifications').run(cwd, {
      targetFiles: [join(cwd, 'src/unclosed.ts')],
    });
    expect(result.signals.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// sentry-pii-scrubbing: init-without-filter, context PII keys, no-match lines
// =============================================================================

describe('sentry-pii-scrubbing detectors', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = makeFixtureDir('sentry-pii');
    // Sentry.init without beforeSend/beforeBreadcrumb -> tier-1 violation.
    writeFixture(
      cwd,
      'src/init-no-filter.ts',
      [
        'import * as Sentry from sentry',
        'Sentry.init({',
        '  dsn: dsn,',
        '  tracesSampleRate: 1,',
        '})',
      ].join('\n'),
    );
    // setUser with a PII field key (email) -> tier-2 violation.
    writeFixture(
      cwd,
      'src/context-pii.ts',
      [
        'import * as Sentry from sentry',
        'export function tag(email) {',
        '  Sentry.setUser({ email: email })',
        '}',
      ].join('\n'),
    );
    // setExtra with shorthand PII key followed by } -> exercises the '}' branch.
    writeFixture(
      cwd,
      'src/context-shorthand.ts',
      [
        'import * as Sentry from sentry',
        'export function tag(token) {',
        '  Sentry.setExtra({ token })',
        '}',
      ].join('\n'),
    );
    // setUser with a non-PII field only -> field-not-found path, no violation.
    writeFixture(
      cwd,
      'src/context-clean.ts',
      [
        'import * as Sentry from sentry',
        'export function tag(role) {',
        '  Sentry.setUser({ role: role })',
        '}',
      ].join('\n'),
    );
    // Sentry.init WITH beforeSend -> no tier-1 violation.
    writeFixture(
      cwd,
      'src/init-filtered.ts',
      [
        'import * as Sentry from sentry',
        'Sentry.init({',
        '  dsn: dsn,',
        '  beforeSend(event) { return event },',
        '})',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('flags Sentry.init without a PII filter callback', async () => {
    const result = await findCheck('sentry-pii-scrubbing').run(cwd, {
      targetFiles: [join(cwd, 'src/init-no-filter.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('sentry-no-pii-filter');
  });

  it('flags a PII field key passed to a Sentry context call', async () => {
    const result = await findCheck('sentry-pii-scrubbing').run(cwd, {
      targetFiles: [join(cwd, 'src/context-pii.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('sentry-pii-in-context');
  });

  it('flags a shorthand PII key followed by a closing brace', async () => {
    const result = await findCheck('sentry-pii-scrubbing').run(cwd, {
      targetFiles: [join(cwd, 'src/context-shorthand.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).toContain('sentry-pii-in-context');
  });

  it('does not flag a context call with no PII fields', async () => {
    const result = await findCheck('sentry-pii-scrubbing').run(cwd, {
      targetFiles: [join(cwd, 'src/context-clean.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).not.toContain('sentry-pii-in-context');
  });

  it('does not flag a Sentry.init that declares beforeSend', async () => {
    const result = await findCheck('sentry-pii-scrubbing').run(cwd, {
      targetFiles: [join(cwd, 'src/init-filtered.ts')],
    });
    const types = result.signals.map((s) => s.metadata.type);
    expect(types).not.toContain('sentry-no-pii-filter');
  });
});
