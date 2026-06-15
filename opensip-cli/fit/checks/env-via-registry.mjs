/**
 * @fileoverview env-via-registry — environment reads must flow through the
 *               EnvRegistry (§5.12). Project-local SELF-check for opensip-cli.
 *
 * Relocated out of `@opensip-cli/checks-universal` (where it shipped 2.12.0–2.12.x):
 * this check enforces opensip-cli' OWN env-governance model. It mandates reads
 * through the `EnvRegistry` primitive (`@opensip-cli/core`) and allow-lists
 * opensip-cli-internal files (`env-registry.ts` / `host-env-specs.ts` /
 * `theme.ts` / `welcome.ts` / `heap-preflight.ts`). None of that is meaningful to
 * a consumer codebase — the registry doesn't exist there and the allow-list names
 * files only this repo has. It is a tool-internal convention, not a universal one,
 * so it lives here as a dogfood self-check rather than in the shipped pack.
 *
 * Release 2.12.0 made the env surface governed: every variable is a declared
 * `EnvVarSpec` read through the registry so it can be documented and deprecated
 * coherently. A raw `process.env.<NAME>` read bypasses that — the variable never
 * appears in the generated env-surface reference, has no coercion/deprecation
 * policy, and cannot be tested through one seam.
 *
 * `strip-strings-and-comments` keeps the many `process.env.*` mentions in doc
 * comments / suggestion strings / scaffolded config templates from false-firing —
 * only real reads survive. The check packs (`checks-*`) are excluded wholesale
 * (they DESCRIBE env patterns, they don't read env); tests are excluded (they
 * legitimately drive code under test via process.env).
 */
import { defineCheck } from '@opensip-cli/fitness';

/**
 * A real read of a SPECIFIC variable: `process.env.<NAME>` or `process.env[...]`.
 * Deliberately NOT bare `process.env` — forwarding the whole environment to a
 * subprocess (`env: process.env`, `...process.env`, `env = process.env`) is
 * legitimate passthrough, not a governed variable read.
 */
const PROCESS_ENV_RE = /\bprocess\.env\s*(?:\.\w|\[)/;

/** Check packs describe env patterns; they do not read env. Excluded wholesale. */
const CHECK_PACK_PATH = /packages\/[^/]+\/checks-/;

/** Tests legitimately set/read process.env to drive the code under test. */
const TEST_PATH = /\.test\.tsx?$|\/__tests__\//;

/**
 * Files where a raw `process.env` read is sanctioned: the registry primitive and
 * the composed host table (the one read site), plus the documented pre-scope
 * readers that run before any RunScope exists (the cli-ui theme — no `core`
 * dependency — the early colour gate in `welcome.ts`, and the heap-preflight
 * subprocess relaunch which reads NODE_OPTIONS + a relaunch sentinel before any
 * opensip module loads).
 */
const ALLOWLISTED_BASENAMES = new Set([
  'env-registry.ts',
  'host-env-specs.ts',
  'theme.ts',
  'welcome.ts',
  'heap-preflight.ts',
]);

/** Pure analysis. Exported for direct exercise if this check grows a test harness. */
export function analyzeEnvViaRegistry(content) {
  const violations = [];
  for (const [i, line] of content.split('\n').entries()) {
    if (PROCESS_ENV_RE.test(line)) {
      violations.push({
        message:
          'Environment reads must flow through the EnvRegistry (§5.12), not raw ' +
          'process.env — the variable is otherwise ungoverned (no docs, coercion, ' +
          'or deprecation) and invisible to the generated env-surface reference.',
        severity: 'error',
        line: i + 1,
        suggestion:
          'Declare an EnvVarSpec and read it via EnvRegistry.get(). If this is a ' +
          'genuine pre-scope reader that cannot reach a registry, allow-list it ' +
          'here with a justification (see env-registry / host-env-specs / theme).',
      });
    }
  }
  return violations;
}

// ===========================================================================
// SECOND project-local self-check in this file: env-registry-undeclared-read
// ---------------------------------------------------------------------------
// The sibling above mandates reading env THROUGH the registry. This one closes
// the other half: a registry read must name a DECLARED variable.
//
// WHY: `hostEnv.get('NAME')` resolves through `EnvRegistry`, which THROWS
// `EnvRegistry: unknown variable 'NAME'` for any canonical with no EnvVarSpec.
// The read often sits OUTSIDE a try/catch (e.g. the profiling gate that aborted
// every telemetry-enabled run — the audit's CRITICAL finding), so an undeclared
// read is not a quiet `undefined` fallback: it crashes the command before its
// body runs. This guard fails the build the moment a governed read names a
// variable that has no spec.
//
// Cross-file (`analyzeAll`): pass 1 collects every declared `canonical: 'NAME'`
// across the scanned sources; pass 2 flags any `hostEnv.get/read('NAME')` whose
// NAME is absent. If NO declarations are found (the spec table wasn't in scope),
// it bails rather than flag everything. Limitation: a name declared in ANY spec
// table counts as declared — it does not model which registry loads which table.
// ===========================================================================

/** A governed env-var declaration: `canonical: 'NAME'`. */
const CANONICAL_DECL_RE = /\bcanonical:\s*(['"])([A-Z][A-Z0-9_]*)\1/g;

/**
 * A governed read through the host env registry: `hostEnv.get('NAME')`,
 * `hostEnv.read('NAME')`, or `<x>EnvRegistry.get/read('NAME')` (optional generic
 * type arg). The UPPER_SNAKE argument keeps `someMap.get('aKey')` from matching.
 */
const REGISTRY_READ_RE =
  /\b(?:hostEnv|envRegistry|[A-Za-z]\w*EnvRegistry)\.(?:get|read)\s*(?:<[^>]*>)?\s*\(\s*(['"])([A-Z][A-Z0-9_]*)\1/g;

/** A comment-only line — raw content, so prose mentioning the patterns must be skipped. */
function isEnvCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
}

/**
 * Pure two-pass analysis over a path→content map (what `FileAccessor.readAll()`
 * returns). Exported for direct exercise if this check grows a test harness.
 */
export function analyzeEnvRegistryUndeclaredRead(filesByPath) {
  // Pass 1: every declared canonical name across the scanned sources.
  const declared = new Set();
  for (const content of filesByPath.values()) {
    for (const line of content.split('\n')) {
      if (isEnvCommentLine(line)) continue;
      CANONICAL_DECL_RE.lastIndex = 0;
      let m;
      while ((m = CANONICAL_DECL_RE.exec(line)) !== null) declared.add(m[2]);
    }
  }
  // No declarations in scope → cannot validate; bail rather than false-flag.
  if (declared.size === 0) return [];

  // Pass 2: flag governed reads of an undeclared variable.
  const violations = [];
  for (const [filePath, content] of filesByPath) {
    if (CHECK_PACK_PATH.test(filePath) || TEST_PATH.test(filePath)) continue;
    for (const [i, line] of content.split('\n').entries()) {
      if (isEnvCommentLine(line)) continue;
      REGISTRY_READ_RE.lastIndex = 0;
      let m;
      while ((m = REGISTRY_READ_RE.exec(line)) !== null) {
        const name = m[2];
        if (declared.has(name)) continue;
        violations.push({
          filePath,
          line: i + 1,
          message:
            `Env read of '${name}' has no declared EnvVarSpec. EnvRegistry throws ` +
            `"unknown variable '${name}'" for an undeclared canonical name — and the ` +
            `read often sits outside a try/catch, so it crashes the command before its ` +
            `body runs (the profiling-gate CRITICAL).`,
          severity: 'error',
          suggestion:
            `Declare '${name}' as an EnvVarSpec in the appropriate *_ENV_SPECS table ` +
            `(e.g. CLI_ENV_SPECS in host-env-specs.ts) so hostEnv.get returns undefined ` +
            `when unset instead of throwing, and it appears in the env-surface reference.`,
          type: 'env-registry-undeclared-read',
        });
      }
    }
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: '992a80ac-58b5-422d-8a86-12f22f82d6e5',
    slug: 'env-via-registry',
    description: 'Environment reads must flow through the EnvRegistry, not raw process.env (§5.12)',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'quality'],
    fileTypes: ['ts', 'tsx'],
    contentFilter: 'strip-strings-and-comments',
    analyze: (content, filePath) => {
      if (CHECK_PACK_PATH.test(filePath) || TEST_PATH.test(filePath)) return [];
      const basename = filePath.split('/').at(-1) ?? '';
      if (ALLOWLISTED_BASENAMES.has(basename)) return [];
      return analyzeEnvViaRegistry(content);
    },
  }),
  defineCheck({
    id: '0ea42b99-95bf-4846-b4fc-4066b3b1fecf',
    slug: 'env-registry-undeclared-read',
    description:
      'Every EnvRegistry read (hostEnv.get/read("NAME")) must reference a declared EnvVarSpec — an undeclared canonical name throws "unknown variable" at runtime, aborting the command',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'quality'],
    fileTypes: ['ts', 'tsx'],
    // raw: the canonical declaration strings AND the read-argument strings are the
    // signal — strip-strings would blank both. Comment lines are skipped in the analyzer.
    contentFilter: 'raw',
    analyzeAll: async (files) => analyzeEnvRegistryUndeclaredRead(await files.readAll()),
  }),
];
