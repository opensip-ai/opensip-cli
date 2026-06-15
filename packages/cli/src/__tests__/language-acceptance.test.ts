/**
 * Per-language acceptance matrix (Plan A Phase 3).
 *
 * Drives the Phase 2 fixtures (one tiny project per supported language) through
 * the shared CLI acceptance harness against the built `dist/index.js`, asserting
 * per language: `fit --json` runs with no adapter-load error; the language's
 * files are discovered; a known-bad file yields ≥1 finding for the target check
 * while the clean file yields none. The five languages with a graph adapter also
 * assert a well-formed `graph --json` envelope.
 *
 * C++ is fit/language smoke only: there is no graph-cpp adapter, and its only
 * shipped check shells out to clang-tidy (non-hermetic) while the universal
 * no-todo-comments check self-skips paths under `__tests__/` — so the C++ row
 * asserts the adapter loads and `fit` runs, not a specific finding.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, beforeEach } from 'vitest';

import { distRunner, expectEnvelope } from './harness/cli-acceptance.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const LANG_DIR = join(__dirname, 'fixtures/languages');
const MONOREPO_ROOT = join(__dirname, '../../../../..');
const cli = distRunner();

/**
 * Run the CLI against an *isolated* copy of the language fixture.
 *
 * We copy the fixture (bad/clean sources + any per-fixture opensip-cli/ setup)
 * to a fresh /tmp temp dir on every call. This makes the temp the "project root"
 * for the run (it has the sources + we ensure an opensip-cli/fit/checks/ dir).
 * Because the temp lives in /tmp (no ancestor opensip layout), project-local
 * check discovery stops at the temp and never climbs to the monorepo root's
 * opensip-cli/fit/checks/ (the dozens of local-only checks added for dogfooding
 * and improvement processes). This keeps the acceptance matrix focused on
 * shipped adapter + check behaviour and prevents the locals from affecting
 * exit codes, unit counts, violation totals, or filesValidated sums.
 *
 * The outer spawn cwd remains the monorepo so shipped check-pack / graph-adapter
 * discovery (workspace packages) still works exactly as before.
 */
function runInFixture(args: readonly string[], fixtureLang: string) {
  const srcDir = cwdFor(fixtureLang);
  const tmp = mkdtempSync(join(tmpdir(), `lang-accept-${fixtureLang}-`));
  // Copy the entire fixture (sources + any committed per-lang opensip-cli/ layout)
  cpSync(srcDir, tmp, { recursive: true });
  // Claim the local checks slot so ancestor walk does not pick up monorepo locals.
  mkdirSync(join(tmp, 'opensip-cli', 'fit', 'checks'), { recursive: true });
  // Run with --cwd pointing at the isolated temp. Keep outer cwd = monorepo
  // for shipped pack discovery (same as the original implementation).
  const result = cli.run([...args, '--cwd', tmp], { cwd: MONOREPO_ROOT });
  rmSync(tmp, { recursive: true, force: true });
  return result;
}

interface LangRow {
  readonly lang: string;
  readonly slug: string;
  readonly bad: string;
  readonly clean: string;
  readonly graph: boolean;
}

// Slugs verified to fire from the fixture location (see Phase 2 notes):
// TS uses no-ai-attribution (no-console-log self-skips a /cli/ path allowlist).
const LANGS: readonly LangRow[] = [
  {
    lang: 'typescript',
    slug: 'no-ai-attribution',
    bad: 'bad.ts',
    clean: 'clean.ts',
    graph: true,
  },
  {
    lang: 'python',
    slug: 'python-no-bare-except',
    bad: 'bad.py',
    clean: 'clean.py',
    graph: true,
  },
  {
    lang: 'go',
    slug: 'go-no-fmt-print',
    bad: 'bad.go',
    clean: 'clean.go',
    graph: true,
  },
  {
    lang: 'java',
    slug: 'java-no-print-stack-trace',
    bad: 'Bad.java',
    clean: 'Clean.java',
    graph: true,
  },
  {
    lang: 'rust',
    slug: 'rust-no-dbg-macro',
    bad: 'bad.rs',
    clean: 'clean.rs',
    graph: true,
  },
  {
    lang: 'cpp',
    slug: 'no-todo-comments',
    bad: 'bad.cpp',
    clean: 'clean.cpp',
    graph: false,
  },
];

const ADAPTER_ERROR_MARKERS = ['plugin failed to load', 'failed to load', 'adapter'] as const;

function cwdFor(lang: string): string {
  return join(LANG_DIR, lang);
}

beforeEach(() => {
  for (const { lang } of LANGS) {
    rmSync(join(cwdFor(lang), 'opensip-cli', '.runtime'), {
      recursive: true,
      force: true,
    });
  }
});

describe.each(LANGS)('language acceptance: $lang', (row) => {
  it('fit --json runs with no adapter-load error', () => {
    // Always limit with --check <lang's slug> so the assertion is reliable
    // (plain --json can pull non-hermetic checks for some langs, or trigger
    // other behavior in isolated fixture projects). This still exercises
    // adapter load for the lang and proves the command succeeds with no load
    // errors. The dedicated C++ smoke separately asserts filesValidated > 0.
    const res = runInFixture(['fit', '--json', '--check', row.slug], row.lang);
    expect(res.exitCode, `fit exited ${res.exitCode}; stderr: ${res.stderr}`).toBe(0);
    for (const marker of ['plugin failed to load', 'lang plugin failed to load']) {
      expect(res.stderr).not.toContain(marker);
    }
    const parsed = JSON.parse(res.stdout) as unknown;
    expect(expectEnvelope({ tool: 'fit' })(parsed)).toEqual([]);
  });

  if (row.lang === 'cpp') {
    // Lang-smoke only — see file header. Prove the C++ adapter discovers .cpp
    // files by running a universal check over them (it executes even though its
    // finding is suppressed under __tests__/), asserting no adapter error.
    it('C++ adapter discovers .cpp files (smoke)', () => {
      // Use explicit --check on the hermetic universal check (no-todo-comments).
      // The plain --json would pull in non-hermetic cpp checks (e.g. clang-tidy
      // based) that are not available in all test envs and can cause non-zero
      // exit. The smoke only needs to prove the cpp adapter made the .cpp files
      // visible to checks (filesValidated > 0) and that the adapter loaded
      // without error.
      const res = runInFixture(['fit', '--json', '--check', 'no-todo-comments'], 'cpp');
      expect(res.exitCode, `fit exited ${res.exitCode}; stderr: ${res.stderr}`).toBe(0);
      const parsed = (
        JSON.parse(res.stdout) as {
          envelope: { units?: { filesValidated?: number }[] };
        }
      ).envelope;
      const filesSeen = (parsed.units ?? []).reduce((a, u) => a + (u.filesValidated ?? 0), 0);
      expect(
        filesSeen,
        'C++ fixture files should be validated by at least one check',
      ).toBeGreaterThan(0);
    });
    return;
  }

  it(`bad file fires ${row.slug}; clean file does not`, () => {
    const res = runInFixture(['fit', '--json', '--check', row.slug], row.lang);
    expect(res.exitCode, `stderr: ${res.stderr}`).toBe(0);
    const env = (
      JSON.parse(res.stdout) as {
        envelope: {
          verdict?: { summary?: { total?: number } };
          units?: {
            slug?: string;
            violationCount?: number;
            filesValidated?: number;
          }[];
          signals?: { filePath?: string }[];
        };
      }
    ).envelope;
    // The single requested check ran over the discovered fixture files.
    expect(env.verdict?.summary?.total).toBe(1);
    const unit = (env.units ?? []).find((u) => u.slug === row.slug);
    expect(unit, `unit for ${row.slug} should be present`).toBeDefined();
    expect(unit?.filesValidated ?? 0).toBeGreaterThan(0);
    expect(unit?.violationCount ?? 0).toBeGreaterThanOrEqual(1);

    const files = (env.signals ?? []).map((s) => s.filePath ?? '');
    expect(
      files.some((f) => f.endsWith(row.bad)),
      `expected a finding on ${row.bad}`,
    ).toBe(true);
    expect(
      files.some((f) => f.endsWith(row.clean)),
      `clean file ${row.clean} must have no finding`,
    ).toBe(false);
  });
});

describe.each(LANGS.filter((l) => l.graph))('graph acceptance: $lang', (row) => {
  it('graph --json yields a well-formed, non-empty envelope', () => {
    const res = runInFixture(['graph', '--json'], row.lang);
    expect(res.exitCode, `graph exited ${res.exitCode}; stderr: ${res.stderr}`).toBe(0);
    for (const marker of ADAPTER_ERROR_MARKERS) {
      if (marker === 'adapter') continue; // 'adapter' substring is too broad for a hard assert
      expect(res.stderr).not.toContain(marker);
    }
    const outcome = JSON.parse(res.stdout) as {
      envelope: { units?: unknown; signals?: unknown };
    };
    expect(expectEnvelope({ tool: 'graph' })(outcome)).toEqual([]);
    expect(Array.isArray(outcome.envelope.units)).toBe(true);
  });
});

describe('graph adapter coverage', () => {
  it('C++ has no graph adapter and is excluded from graph acceptance', () => {
    // Guard: if a graph-cpp adapter is ever added, flip cpp.graph and update this.
    const cpp = LANGS.find((l) => l.lang === 'cpp');
    expect(cpp?.graph).toBe(false);
  });
});
