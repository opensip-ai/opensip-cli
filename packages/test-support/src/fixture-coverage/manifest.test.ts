/**
 * Unit tests for the per-check fixture-coverage manifest (testing gap P0).
 *
 * `buildFixtureManifest` and `validateBookkeeping` are pure functions over the
 * runtime `Check` config, so these tests drive them with minimal synthetic
 * checks (only `.config` is read). The cross-pack slug parity with the docs
 * enumerator (`scripts/extract-checks-metadata.mjs`) lives in a layer-clean
 * location in Phase 5 — the engine cannot import the downstream check packs.
 */

import { describe, expect, it } from 'vitest';

import { buildFixtureManifest, extForLanguage, validateBookkeeping } from './manifest.js';

import type { CoverageConfig } from './manifest.js';
import type { Check } from '@opensip-tools/fitness';

type CheckConfig = Check['config'];

/** Minimal Check whose `.config` carries only what the manifest reads. */
function check(config: Partial<CheckConfig> & { slug: string }): Check {
  const full = {
    id: config.slug,
    tags: [],
    description: '',
    analysisMode: 'analyze',
    ...config,
  } as CheckConfig;
  return { config: full } as unknown as Check;
}

const noExemptions = { commandExemptions: {} };

/** Coverage config with the ratchet silenced unless a test targets it. */
function coverageConfig(over: Partial<CoverageConfig>): CoverageConfig {
  return {
    packName: 'test',
    checks: [],
    allowlist: [],
    commandExemptions: {},
    allowNonEmptyAllowlist: true,
    ...over,
  };
}

describe('extForLanguage', () => {
  it('maps known languages and falls back to the raw string', () => {
    expect(extForLanguage('typescript')).toBe('ts');
    expect(extForLanguage('rust')).toBe('rs');
    expect(extForLanguage('cpp')).toBe('cpp');
    expect(extForLanguage('kotlin')).toBe('kotlin'); // visible fallback
  });
});

describe('buildFixtureManifest', () => {
  it('language-scoped check → language domain with per-language basenames', () => {
    const [req] = buildFixtureManifest(
      [check({ slug: 'a', checkScope: { languages: ['typescript', 'python'], concerns: [] } })],
      noExemptions,
    );
    expect(req.domain).toEqual({ kind: 'language', languages: ['typescript', 'python'] });
    expect(req.fixtureBasenames).toEqual(['ts', 'py']);
  });

  it('empty languages → universal domain (clean.txt/violation.txt)', () => {
    const [req] = buildFixtureManifest(
      [check({ slug: 'u', checkScope: { languages: [], concerns: [] } })],
      noExemptions,
    );
    expect(req.domain.kind).toBe('universal');
    expect(req.fixtureBasenames).toEqual(['txt']);
  });

  it('fileTypes-only check → file-typed domain with ONE representative basename', () => {
    const [req] = buildFixtureManifest(
      [check({ slug: 'f', fileTypes: ['md', '.yml'] })],
      noExemptions,
    );
    expect(req.domain).toEqual({ kind: 'file-typed', fileTypes: ['md', '.yml'] });
    // A multi-extension check needs only one representative pair (first type).
    expect(req.fixtureBasenames).toEqual(['md']);
  });

  it('filenameOverrides wins over the derived basename', () => {
    const [req] = buildFixtureManifest([check({ slug: 'pkg', fileTypes: ['json'] })], {
      commandExemptions: {},
      filenameOverrides: { pkg: 'package.json' },
    });
    expect(req.fixtureBasenames).toEqual(['package.json']);
  });

  it('disabled checks are skipped', () => {
    const reqs = buildFixtureManifest([check({ slug: 'off', disabled: true })], noExemptions);
    expect(reqs).toHaveLength(0);
  });

  it('command-mode check → command-exempt with its reason', () => {
    const [req] = buildFixtureManifest([check({ slug: 'cmd', analysisMode: 'command' })], {
      commandExemptions: { cmd: 'shells out to a binary' },
    });
    expect(req.domain).toEqual({ kind: 'command-exempt', reason: 'shells out to a binary' });
    expect(req.fixtureBasenames).toEqual([]);
  });

  it('command-mode check with no exemption reason throws', () => {
    expect(() =>
      buildFixtureManifest([check({ slug: 'cmd', analysisMode: 'command' })], noExemptions),
    ).toThrow(/no exemption reason/);
  });
});

describe('validateBookkeeping', () => {
  it('healthy config → no problems', () => {
    expect(validateBookkeeping(coverageConfig({ checks: [check({ slug: 'a' })] }))).toEqual([]);
  });

  it('flags an allowlist entry that no longer ships', () => {
    const problems = validateBookkeeping(
      coverageConfig({ checks: [check({ slug: 'a' })], allowlist: ['gone'] }),
    );
    expect(problems.some((p) => p.includes("'gone'"))).toBe(true);
  });

  it('flags a slug in both allowlist and commandExemptions', () => {
    const problems = validateBookkeeping(
      coverageConfig({
        checks: [check({ slug: 'cmd', analysisMode: 'command' })],
        allowlist: ['cmd'],
        commandExemptions: { cmd: 'x' },
      }),
    );
    expect(problems.some((p) => p.includes('BOTH'))).toBe(true);
  });

  it('flags a command-mode check that is not exempted', () => {
    const problems = validateBookkeeping(
      coverageConfig({ checks: [check({ slug: 'cmd', analysisMode: 'command' })] }),
    );
    expect(problems.some((p) => p.includes('not in commandExemptions'))).toBe(true);
  });

  it('flags an exemption for a non-command check', () => {
    const problems = validateBookkeeping(
      coverageConfig({ checks: [check({ slug: 'a' })], commandExemptions: { a: 'why' } }),
    );
    expect(problems.some((p) => p.includes("not analysisMode:'command'"))).toBe(true);
  });

  it('ratchet: a non-empty allowlist is a problem unless explicitly waived', () => {
    const checks = [check({ slug: 'a' })];
    expect(
      validateBookkeeping(
        coverageConfig({ checks, allowlist: ['a'], allowNonEmptyAllowlist: false }),
      ),
    ).not.toEqual([]);
    expect(
      validateBookkeeping(
        coverageConfig({ checks, allowlist: ['a'], allowNonEmptyAllowlist: true }),
      ),
    ).toEqual([]);
  });

  it('flags a commandExemptions entry that no longer ships', () => {
    const problems = validateBookkeeping(
      coverageConfig({ checks: [check({ slug: 'a' })], commandExemptions: { gone: 'why' } }),
    );
    expect(
      problems.some(
        (p) => p.includes("commandExemptions names 'gone'") && p.includes('no longer ships'),
      ),
    ).toBe(true);
  });

  it('healthy config with a valid knownUnfixturable entry → no problems', () => {
    const problems = validateBookkeeping(
      coverageConfig({
        checks: [check({ slug: 'a' })],
        knownUnfixturable: { a: 'absolute repo paths' },
      }),
    );
    expect(problems).toEqual([]);
  });

  it('flags a knownUnfixturable entry that no longer ships', () => {
    const problems = validateBookkeeping(
      coverageConfig({ checks: [check({ slug: 'a' })], knownUnfixturable: { gone: 'why' } }),
    );
    expect(problems.some((p) => p.includes("knownUnfixturable names 'gone'"))).toBe(true);
  });

  it('flags a knownUnfixturable entry that is actually a command check', () => {
    const problems = validateBookkeeping(
      coverageConfig({
        checks: [check({ slug: 'cmd', analysisMode: 'command' })],
        commandExemptions: { cmd: 'shells out' },
        knownUnfixturable: { cmd: 'should be commandExemptions' },
      }),
    );
    expect(problems.some((p) => p.includes('put it in commandExemptions'))).toBe(true);
  });

  it('flags a knownUnfixturable entry with an empty reason', () => {
    const problems = validateBookkeeping(
      coverageConfig({ checks: [check({ slug: 'a' })], knownUnfixturable: { a: '' } }),
    );
    expect(problems.some((p) => p.includes('needs a non-empty reason'))).toBe(true);
  });

  it('flags a slug listed in BOTH allowlist and knownUnfixturable', () => {
    const problems = validateBookkeeping(
      coverageConfig({
        checks: [check({ slug: 'a' })],
        allowlist: ['a'],
        knownUnfixturable: { a: 'reason' },
      }),
    );
    expect(problems.some((p) => p.includes('BOTH allowlist and knownUnfixturable'))).toBe(true);
  });

  it('flags a slug listed in BOTH knownUnfixturable and commandExemptions', () => {
    const problems = validateBookkeeping(
      coverageConfig({
        checks: [check({ slug: 'a' })],
        commandExemptions: { a: 'cmd reason' },
        knownUnfixturable: { a: 'unfix reason' },
      }),
    );
    expect(problems.some((p) => p.includes('BOTH knownUnfixturable and commandExemptions'))).toBe(
      true,
    );
  });
});
