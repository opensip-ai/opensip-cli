// @fitness-ignore-file shipped-checks-must-be-generic -- opensip-internal dogfood check (plan 09 Task 1.3, ADR-paired): path-gated to opensip's own check packs; inert for adopters.
/**
 * @fileoverview String pre-filter ⊇ authoritative matcher (the superset
 * invariant, plan 09 Phase 1 / ADR-paired).
 *
 * A check that gates its authoritative AST/regex pass on a hand-authored
 * substring pre-filter must keep the filter a strict SUPERSET of what the
 * matcher can match — a narrower filter is a latent false-negative that
 * green-passes real findings (the shipped `no-any-types` bug: `': any'`
 * required a space, so `:any` returned CLEAN without running the checker).
 *
 * The invariant is semantic; this check mechanizes its two proven
 * high-confidence violation classes:
 *  A. a QUICK_FILTER keyword list containing an element with LEADING or
 *     TRAILING whitespace — formatting-variant-sensitive by construction
 *     (a formatter rewrite defeats it);
 *  B. an END-anchored regex tested against whole-file `content` — `/x$/`
 *     only matches a file whose final bytes are `x` (the
 *     in-memory-repository-detection dead-gate bug); anchors belong on the
 *     extracted name, never the content gate.
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

const CHECK_PACK_PATH = /(?:^|\/)packages\/fitness\/checks-[^/]+\/src\/checks\//;
const NON_SOURCE = /(?:\.test\.tsx?$|\/__tests__\/|\/__fixtures__\/)/;

/** A QUICK_FILTER-style const array literal (single declaration, one line or many). */
const QUICK_FILTER_ARRAY = /QUICK_FILTER\w*\s*=\s*\[([^\]]*)\]/g;

/** String literal elements inside the matched array body. */
const STRING_ELEMENT = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;

/** An end-anchored regex literal tested directly against whole-file content. */
const ANCHORED_CONTENT_TEST = /\/(?:[^\n/\\]|\\.)*(?<!\\)\$\/[a-z]*\.test\(\s*content\s*\)/g;

export function analyzeStringPrefilterSuperset(
  content: string,
  filePath: string,
): CheckViolation[] {
  const normalized = filePath.replaceAll('\\', '/');
  if (!CHECK_PACK_PATH.test(normalized) || NON_SOURCE.test(normalized)) return [];
  const violations: CheckViolation[] = [];

  for (const arrayMatch of content.matchAll(QUICK_FILTER_ARRAY)) {
    const body = arrayMatch[1] ?? '';
    for (const element of body.matchAll(STRING_ELEMENT)) {
      const value = element[1] ?? element[2] ?? '';
      if (value !== value.trim()) {
        const line = content.slice(0, arrayMatch.index).split('\n').length;
        violations.push({
          line,
          filePath,
          message:
            `Quick-filter keyword '${value}' carries leading/trailing whitespace — a ` +
            'formatting variant a formatter would rewrite defeats it, so the filter is ' +
            'NARROWER than the authoritative matcher (latent false-negative).',
          severity: 'error',
          suggestion:
            'Make the pre-filter a strict superset of the matcher: gate on the bare ' +
            'token substring and let the authoritative AST/regex pass be the arbiter.',
          type: 'string-prefilter-superset',
        });
        break;
      }
    }
  }

  for (const anchorMatch of content.matchAll(ANCHORED_CONTENT_TEST)) {
    const line = content.slice(0, anchorMatch.index).split('\n').length;
    violations.push({
      line,
      filePath,
      message:
        'End-anchored regex tested against whole-file content — `/x$/` only matches a ' +
        'file whose final bytes are `x`, so this gate is dead or near-dead on real ' +
        '(newline-terminated) files.',
      severity: 'error',
      suggestion:
        'Test the anchored pattern against the extracted NAME (class/function/identifier); ' +
        'gate on an unanchored stem substring for the content pre-filter.',
      type: 'string-prefilter-superset',
    });
  }

  return violations;
}

export const stringPrefilterSuperset = defineCheck({
  id: 'c8a4b7d2-1e0f-4c53-8d26-6b9e4a7f0d11',
  slug: 'string-prefilter-superset',
  description:
    'Check-pack string pre-filters must stay a strict superset of the authoritative matcher they gate',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture', 'quality'],
  fileTypes: ['ts'],
  contentFilter: 'raw',
  analyze: (content, filePath) => analyzeStringPrefilterSuperset(content, filePath),
});
