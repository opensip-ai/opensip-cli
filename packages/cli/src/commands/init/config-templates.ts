/**
 * Per-language config and example-source templates for
 * `opensip-tools init`.
 *
 * Owns the bytes that init writes to disk: the YAML config, the
 * example check / recipe / scenario .mjs files, and the pinned UUIDs
 * that drive stale-scaffolded detection.
 */

import { CLI_SUPPORTED_SCHEMA_VERSION } from '@opensip-tools/core';

import type { SupportedLanguage } from './language-detection.js';

interface TargetTemplate {
  readonly name: string;
  readonly description: string;
  readonly languages: readonly string[];
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

function targetTemplate(lang: SupportedLanguage): TargetTemplate {
  switch (lang) {
    case 'typescript': {
      return {
        name: 'typescript-source',
        description: 'TypeScript / TSX source code',
        languages: ['typescript'],
        include: ['src/**/*.ts', 'src/**/*.tsx', 'packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
        exclude: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**', '**/node_modules/**', '**/dist/**'],
      };
    }
    case 'rust': {
      return {
        name: 'rust-source',
        description: 'Rust source code',
        languages: ['rust'],
        include: ['src/**/*.rs', 'crates/**/*.rs', 'services/**/*.rs'],
        exclude: ['**/target/**'],
      };
    }
    case 'python': {
      return {
        name: 'python-source',
        description: 'Python source code',
        languages: ['python'],
        include: ['src/**/*.py', '**/*.py'],
        exclude: ['**/__pycache__/**', '**/.venv/**', '**/venv/**', '**/dist/**', '**/build/**', '**/*.egg-info/**'],
      };
    }
    case 'go': {
      return {
        name: 'go-source',
        description: 'Go source code',
        languages: ['go'],
        include: ['**/*.go'],
        exclude: ['**/vendor/**', '**/_test.go'],
      };
    }
    case 'java': {
      return {
        name: 'java-source',
        description: 'Java source code',
        languages: ['java'],
        include: ['src/main/java/**/*.java', 'src/**/*.java'],
        exclude: ['**/target/**', '**/build/**', '**/*Test.java'],
      };
    }
    case 'cpp': {
      return {
        name: 'cpp-source',
        description: 'C/C++ source code',
        languages: ['cpp'],
        include: ['src/**/*.{c,cpp,cc,h,hpp}', '**/*.{c,cpp,cc,h,hpp}'],
        exclude: ['**/build/**', '**/cmake-build-*/**'],
      };
    }
  }
}

export function generateConfig(languages: readonly SupportedLanguage[]): string {
  const templates = languages.map(targetTemplate);

  const lines: string[] = [
    '# OpenSIP Tools — project configuration',
    '#',
    '# Defines named target file sets for fitness checks. Each fitness',
    '# check declares a `scope` (languages + concerns); discovery',
    '# matches it against these targets to determine which files the',
    '# check runs against.',
    '#',
    '# Docs: https://github.com/opensip-ai/opensip-tools#configuration',
    '',
    `schemaVersion: ${CLI_SUPPORTED_SCHEMA_VERSION}`,
    '',
    'globalExcludes:',
    '  - "**/node_modules/**"',
    '  - "**/dist/**"',
    '',
    'targets:',
  ];

  for (const t of templates) {
    lines.push(
      `  ${t.name}:`,
      `    description: ${t.description}`,
      `    languages: [${t.languages.join(', ')}]`,
      '    concerns: [backend]',
      '    include:',
      ...t.include.map((p) => `      - "${p}"`),
      '    exclude:',
      ...t.exclude.map((p) => `      - "${p}"`),
      '',
    );
  }

  lines.push(
    '# =============================================================================',
    '# Fitness configuration',
    '# =============================================================================',
    '',
    'fitness:',
    '  failOnErrors: 1     # fail if total errors >= this (0 = never fail on errors)',
    '  failOnWarnings: 0   # fail if total warnings >= this (0 = warnings are informational)',
    '  disabledChecks: []',
    '',
  );

  return lines.join('\n');
}

// Stable UUIDs for the scaffolded example checks. Hard-coded (rather
// than generated per-init) so the same project re-running `init --keep`
// or `init --remove` keeps the same id, and so two projects on the same
// machine can run the example simultaneously without spurious id
// collisions in shared session storage. Per-language ids let the
// polyglot scaffold register distinct checks. UUID v4 random bytes —
// produced once and pinned.
//
// These ids also drive stale-scaffolded detection: a file carrying
// EXAMPLE_CHECK_IDS[<lang>] for a language NOT in the current detection
// set is classified as 'stale-scaffolded' and surfaced (preserved) by
// `--keep`.
export const EXAMPLE_CHECK_IDS: Record<SupportedLanguage, string> = {
  typescript: 'a3e1f8c4-9b2d-4f5a-8e6c-7d1a2b3c4d5e',
  rust:       'b4f2e9d5-8c3e-4a6b-9f7d-8e2b3c4d5e6f',
  python:     'c5a3f0e6-7d4f-4b7c-a08e-9f3c4d5e6f70',
  go:         'd6b4a1f7-6e5a-4c8d-b19f-a04d5e6f7081',
  java:       'e7c5b2a8-5f6b-4d9e-c2af-b15e6f708192',
  cpp:        'f8d6c3b9-4a7c-4ea0-d3b0-c26f708192a3',
};

export function exampleCheckSource(language: SupportedLanguage, polyglotSuffix = ''): string {
  // The example check flags any file containing the literal
  // `EXAMPLE_TODO`. Default behavior on a fresh repo is to pass with
  // 0 violations — it scans real files but finds nothing.
  const slug = polyglotSuffix ? `example-check-${polyglotSuffix}` : 'example-check';
  return `// Example fitness check.
//
// Edit this file or add new .mjs files to opensip-tools/fit/checks/.
// Files in this directory are auto-loaded on the next \`opensip-tools fit\` run.
//
// This demo flags any file containing the literal \`EXAMPLE_TODO\`. After
// you confirm the wiring works, delete or replace it with a real check.
//
// Docs: https://github.com/opensip-ai/opensip-tools#authoring-a-check-package
import { defineCheck } from '@opensip-tools/fitness';

export const checks = [
  defineCheck({
    id: '${EXAMPLE_CHECK_IDS[language]}',
    slug: '${slug}',
    description: 'Demo check — flags any file containing the literal EXAMPLE_TODO',
    scope: { languages: ['${language}'], concerns: ['backend'] },
    tags: ['example'],
    analyze: (content, filePath) => {
      const i = content.indexOf('EXAMPLE_TODO');
      if (i < 0) return [];
      return [{
        line: content.slice(0, i).split('\\n').length,
        message: 'Found the example trigger string.',
        severity: 'warning',
        suggestion:
          'This is just a demo. Delete opensip-tools/fit/checks/example-check.mjs ' +
          'once you have your own checks.',
        filePath,
      }];
    },
  }),
];
`;
}

export function exampleRecipeSource(slugs: readonly string[]): string {
  const slugList = slugs.map((s) => `'${s}'`).join(', ');
  return `// Example fitness recipe — runs only the example check(s).
//
// Edit this file or add new .mjs files to opensip-tools/fit/recipes/.
// Files in this directory are auto-loaded on the next run.
//
// Run this recipe explicitly:  opensip-tools fit --recipe example
//
// To run all enabled checks (built-in + your custom ones), omit
// --recipe and the built-in \`default\` recipe applies.
export const recipes = [{
  id: 'URCP_example',
  name: 'example',
  displayName: 'Example',
  description: 'Demo recipe — runs only the example check(s)',
  checks: { type: 'explicit', checkIds: [${slugList}] },
  execution: { mode: 'parallel', stopOnFirstFailure: false, timeout: 30_000 },
  reporting: { format: 'table', verbose: false },
}];
`;
}

export function exampleScenarioSource(): string {
  return `// Example simulation scenario — a real load window against an in-process target.
//
// 'sim' is a standalone driver: you bring the target. This demo drives a
// trivial in-process target so it runs out-of-box and shows the harness
// mechanics (a real request loop, measured latency, asserted SLOs). To test
// YOUR service, replace 'target' with httpTarget({ url: process.env.TARGET_URL })
// — and point it only at a target you own. For fault injection, see the chaos
// docs (defineChaosScenario + fault.*).
//
// Edit this file or add new .mjs files to opensip-tools/sim/scenarios/.
// Files in this directory are auto-loaded on the next \`opensip-tools sim\` run.
//
// Docs: https://github.com/opensip-ai/opensip-tools#simulation
import { defineLoadScenario, ASSERTIONS /*, httpTarget */ } from '@opensip-tools/simulation';

export const scenarios = [
  defineLoadScenario({
    id: 'example-scenario',
    name: 'example-scenario',
    description: 'Demo load scenario — drives a trivial in-process target',
    tags: ['example'],
    // BYO target: any async function that resolves on success / throws on failure.
    // Swap for your service:  target: httpTarget({ url: process.env.TARGET_URL }),
    target: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    workload: { rps: 20, rampUp: 1 },
    duration: 3,
    assertions: [ASSERTIONS.lowErrorRate(), ASSERTIONS.lowLatency('p95', 500)],
  }),
];
`;
}

export function exampleSimRecipeSource(): string {
  return `// Example simulation recipe — runs only the example scenario.
//
// Edit this file or add new .mjs files to opensip-tools/sim/recipes/.
// Files in this directory are auto-loaded on the next run.
//
// Run this recipe explicitly:  opensip-tools sim --recipe example
import { defineSimulationRecipe } from '@opensip-tools/simulation';

export const recipes = [
  defineSimulationRecipe({
    id: 'URCP_sim_example',
    name: 'example',
    displayName: 'Example',
    description: 'Demo recipe — runs only the example scenario',
    scenarios: { type: 'explicit', scenarioIds: ['example-scenario'] },
    execution: { mode: 'parallel', timeout: 30_000 },
  }),
];
`;
}
