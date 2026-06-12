/**
 * @fileoverview Enforce ADR-0017: the tag-driven release workflow's correctness
 * gate must be AT LEAST AS STRICT as the PR gate.
 *
 * ADR-0017 ("Release gate must be at least as strict as the PR gate"):
 * npm package versions are immutable (ADR-0012: old versions are retired via
 * `npm deprecate`, never `unpublish`), so the release lane is the last gate
 * before an unrecoverable artifact. `.github/workflows/release.yml` MUST
 * therefore re-run every PR-quality gate `.github/workflows/ci.yml` runs —
 * `pnpm lint`, `pnpm test:coverage`, `pnpm fit:ci`, and `pnpm graph:ci` — and
 * those gates MUST run BEFORE the pack/publish steps, so a tag cannot publish
 * after a code path that would have failed PR CI (a lint regression, coverage
 * drift, or a net-new dogfood finding).
 *
 * Nothing else mechanizes this ORDERING/PARITY half of the policy.
 * `scripts/verify-release.mjs` checks version/changelog/package-set
 * consistency; `scripts/verify-supply-chain.mjs` checks frozen-install/OIDC.
 * Neither asserts that the four gate commands are present, nor that they run
 * before pack. This check closes that gap by reading `release.yml` directly.
 *
 * DETECTION — line-oriented text scan (NOT YAML parse). The four gates and the
 * pack step are matched as `run:` command invocations exactly as they appear in
 * the workflow (`run: pnpm lint`, `pnpm --filter "$filter" pack ...`). Matching
 * is tolerant of surrounding flags/args — the gate must be PRESENT, not in a
 * specific exact form. Two violation classes, each bounded (it can reach zero):
 *   1. ABSENCE   — a required gate command never appears in the file.
 *   2. ORDERING  — a present gate's FIRST occurrence is on a line at or after
 *                  the pack step, i.e. it could run after a tarball is already
 *                  built (and thus after the publish path it was meant to guard).
 *
 * SCOPE GUARD — implemented inside `analyze` by inspecting `filePath`, so the
 * check is self-contained and fires ONLY for `.github/workflows/release.yml`
 * regardless of the project `targets` config. Any other file returns `[]`.
 *
 * SEVERITY — `error` / tags `['architecture', 'ci', 'release']`: this guards an
 * immutable publish boundary, aligned with the sibling ADR-enforcing
 * architecture gates in this pack.
 */
import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

/**
 * Path fragment that identifies the tag-driven release workflow. The check is
 * a no-op for every other file. Normalised to forward slashes so it matches on
 * any platform; `endsWith` keeps it anchored to the real workflow rather than a
 * lookalike elsewhere in the tree.
 */
const RELEASE_WORKFLOW_SUFFIX = '.github/workflows/release.yml';

/**
 * The four PR-quality gates ADR-0017 requires `release.yml` to re-run, keyed by
 * the canonical `pnpm <gate>` command. Each `pattern` matches the command as a
 * `run:` invocation, tolerant of leading `run:`/indentation and trailing
 * flags/args, but requires the gate token to be present as a whole word.
 */
const REQUIRED_GATES: readonly { command: string; pattern: RegExp }[] = [
  { command: 'pnpm lint', pattern: /pnpm\s+lint(?:\s|$)/m },
  { command: 'pnpm test:coverage', pattern: /pnpm\s+test:coverage(?:\s|$)/m },
  { command: 'pnpm fit:ci', pattern: /pnpm\s+fit:ci(?:\s|$)/m },
  { command: 'pnpm graph:ci', pattern: /pnpm\s+graph:ci(?:\s|$)/m },
];

/**
 * Identifies the pack step — the line that packs a workspace package into a
 * tarball (`pnpm ... pack ...`). Every gate must appear before this. The shape
 * in `release.yml` is `pnpm --filter "$filter" pack --pack-destination ...`;
 * the pattern requires `pnpm` followed (allowing flags) by a `pack` word so a
 * stray "pack" in prose or a step NAME does not false-match.
 */
const PACK_STEP = /pnpm\s+(?:--\S+\s+(?:"[^"]*"\s+)?)*pack(?:\s|$)/;

/**
 * Find the 1-based line number of the first line matching `pattern`, or `null`
 * if no line matches. Line-by-line so we can report a precise location and
 * compare ordering against the pack step.
 */
function firstMatchingLine(lines: readonly string[], pattern: RegExp): number | null {
  for (const [i, line] of lines.entries()) {
    if (pattern.test(line)) return i + 1;
  }
  return null;
}

/**
 * Pure analysis function. Exported so unit tests can exercise the detection
 * logic without standing up the full Check framework. `filePath` gates the
 * release-workflow scope; `content` is the raw `release.yml` text.
 */
export function analyzeReleaseGateParity(content: string, filePath: string): CheckViolation[] {
  // Scope guard: this check only ever applies to the release workflow.
  if (!filePath.replaceAll('\\', '/').endsWith(RELEASE_WORKFLOW_SUFFIX)) return [];

  const violations: CheckViolation[] = [];
  const lines = content.split('\n');
  const packLine = firstMatchingLine(lines, PACK_STEP);

  for (const gate of REQUIRED_GATES) {
    const gateLine = firstMatchingLine(lines, gate.pattern);

    if (gateLine === null) {
      // (1) ABSENCE — the gate never runs in the release lane.
      violations.push({
        line: 1,
        message:
          `Release workflow is missing the \`${gate.command}\` gate. ADR-0017 ` +
          'requires release.yml to re-run every PR-quality gate (pnpm lint, ' +
          'pnpm test:coverage, pnpm fit:ci, pnpm graph:ci) before pack/publish — ' +
          'npm versions are immutable, so the release lane is the last gate ' +
          'before an unrecoverable artifact.',
        severity: 'error',
        suggestion:
          `Add a step running \`${gate.command}\` to release.yml BEFORE the pack ` +
          'step, mirroring .github/workflows/ci.yml (ADR-0017).',
      });
      continue;
    }

    // (2) ORDERING — a present gate that runs at or after the pack step could
    // execute after a tarball is already built, defeating its purpose.
    if (packLine !== null && gateLine >= packLine) {
      violations.push({
        line: gateLine,
        message:
          `Release gate \`${gate.command}\` runs at or after the pack step ` +
          `(line ${packLine}). ADR-0017 requires all four PR-quality gates to ` +
          'run BEFORE pack/publish so a tag cannot publish after a path that ' +
          'would have failed PR CI.',
        severity: 'error',
        suggestion:
          `Move the \`${gate.command}\` step above the pack step in release.yml ` + '(ADR-0017).',
      });
    }
  }

  return violations;
}

export const releaseGateParity = defineCheck({
  id: 'f4a9c2e7-1b86-4d35-9e0a-6c8b3f2d7a14',
  slug: 'release-gate-parity',
  description:
    'Ensure release.yml re-runs every PR-quality gate (lint, test:coverage, fit:ci, graph:ci) before pack/publish (ADR-0017)',
  scope: { languages: ['yaml'], concerns: ['config'] },
  tags: ['architecture', 'ci', 'release'],
  contentFilter: 'raw',
  analyze: (content, filePath) => analyzeReleaseGateParity(content, filePath),
});
