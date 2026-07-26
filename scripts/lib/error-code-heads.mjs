/**
 * @fileoverview D11 code-head rule: a constructed error code must belong to a head that is
 * either registered in the build-time catalog manifest or mapped by `legacyFamilyCode`.
 *
 * WHY THIS RULE EXISTS
 * `legacyFamilyCode` ends in `default: return undefined`, and `definitionFromLegacyCode` turns
 * that into `coreSystemErrorCatalog.require('UNKNOWN_FAILURE')` — severity `fatal`, exposure
 * `operator-only`, responsibility `unknown`, exit class `fatal`. So a code whose head nobody
 * mapped does not fail loudly; it silently becomes the most alarming and least actionable
 * definition in the catalog. That is how `ERRORS.CONFIG.NOT_FOUND` — the most common
 * first-run failure in the product — came to tell users "An unexpected internal failure
 * occurred." instead of listing the directories it searched.
 *
 * AFTER THE CLEAN BREAK the rule is simpler and stronger. `legacyFamilyCode` — the head-guessing
 * switch this originally had to read — is gone, so there is no longer any such thing as a
 * "mapped" head that resolves without being registered. A constructed code either resolves to a
 * definition some package declared, or it resolves to `UNKNOWN_FAILURE`. The check is therefore
 * exactly: every constructed code literal must be REGISTERED.
 *
 * The registered set is read from the build-time catalog manifest, never restated here: a
 * hard-coded copy would drift the moment someone edited a catalog, and a drifted guard that
 * still passes is worse than no guard.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Same grammar `assertErrorCodeShape` enforces (`error-definition.ts`). */
const CODE_GRAMMAR = /^[A-Z][A-Z0-9]*(\.[A-Z][A-Z0-9_]*){2,}$/u;

/** `code: 'HEAD.DOMAIN.CONDITION'` — a code being CONSTRUCTED, not merely mentioned. */
const CONSTRUCTED_CODE = /\bcode:\s*(['"])([A-Z][A-Z0-9_.]+)\1/gu;

/**
 * Confirm the head-guessing switch really is gone.
 *
 * If someone reintroduces `legacyFamilyCode`, unregistered codes start silently acquiring axes
 * again and this rule's premise quietly stops holding — so the guard fails loudly rather than
 * passing on a false assumption.
 *
 * @param {string} repoRoot
 */
export function assertNoFamilyFallback(repoRoot) {
  const source = readFileSync(join(repoRoot, 'packages/core/src/lib/error-definition.ts'), 'utf8');
  if (source.includes('function legacyFamilyCode')) {
    throw new Error(
      'legacyFamilyCode was reintroduced in error-definition.ts. The clean break (Plan 01) removed ' +
        'head-guessing on purpose: register the code instead of mapping its head.',
    );
  }
}

/**
 * Read the heads that own at least one registered definition, from the catalog manifest —
 * the same authority that generates the published error-code index.
 *
 * @param {string} repoRoot
 * @returns {{ heads: Set<string>, codes: Set<string> }}
 */
export function readRegisteredHeads(repoRoot) {
  const raw = execFileSync(
    process.execPath,
    [join(repoRoot, 'scripts/extract-error-catalog-metadata.mjs')],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const payload = JSON.parse(raw);
  const heads = new Set();
  const codes = new Set();
  for (const definition of payload.definitions ?? []) {
    codes.add(definition.code);
    const head = definition.code.split('.')[0];
    if (definition.code.includes('.')) heads.add(head);
  }
  return { heads, codes };
}

/**
 * Find every constructed code literal in the given production sources whose head is neither
 * registered nor mapped.
 *
 * @param {string} repoRoot
 * @param {readonly string[]} relFiles repo-relative production source paths
 * @returns {{ path: string, line: number, code: string, head: string }[]}
 */
export function findUnmappedCodeHeads(repoRoot, relFiles) {
  assertNoFamilyFallback(repoRoot);
  const { codes } = readRegisteredHeads(repoRoot);
  /** @type {{ path: string, line: number, code: string, head: string }[]} */
  const violations = [];

  for (const rel of relFiles) {
    let text;
    try {
      text = readFileSync(join(repoRoot, rel), 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('code:')) continue;
    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
      // Skip comment lines: a code named in prose is documentation, not a construction.
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
      CONSTRUCTED_CODE.lastIndex = 0;
      let match;
      while ((match = CONSTRUCTED_CODE.exec(line)) !== null) {
        const code = match[2];
        if (!CODE_GRAMMAR.test(code)) continue;
        // Registration is the ONLY thing that makes a code resolve now.
        if (codes.has(code)) continue;
        violations.push({ path: rel, line: index + 1, code, head: code.slice(0, code.indexOf('.')) });
      }
    }
  }
  return violations;
}

/**
 * Baseline identity for one violation.
 *
 * Deliberately `path::code` and NOT the line: an unrelated edit above the site would
 * otherwise read as new debt, and a ratchet that cries wolf gets disabled. Moving the same
 * construction to a different file IS new debt for the receiving file, which is correct —
 * the point is to stop the head spreading.
 *
 * @param {{ path: string, code: string }} violation
 * @returns {string}
 */
export function codeHeadKey(violation) {
  return `${violation.path}::${violation.code}`;
}

/**
 * Split violations against a recorded baseline.
 *
 * @param {{ path: string, line: number, code: string, head: string }[]} violations
 * @param {readonly string[]} baseline
 */
export function diffAgainstBaseline(violations, baseline) {
  const known = new Set(baseline);
  const present = new Set(violations.map((v) => codeHeadKey(v)));
  return {
    added: violations.filter((v) => !known.has(codeHeadKey(v))),
    resolved: [...known].filter((key) => !present.has(key)).sort(),
  };
}

/**
 * Render violations with the exact repair, per the actionable-diagnostic contract.
 *
 * @param {{ path: string, line: number, code: string, head: string }[]} violations
 * @returns {string}
 */
export function formatCodeHeadViolations(violations) {
  const lines = [
    `error-code-heads: ${violations.length} constructed code(s) whose head is neither registered nor mapped.`,
    '',
    'An unmapped head does NOT fail loudly — definitionFromLegacyCode demotes it to',
    'CORE.SYSTEM.UNKNOWN_FAILURE (severity fatal, exposure operator-only), so the user is told',
    '"An unexpected internal failure occurred." instead of anything actionable.',
    '',
  ];
  for (const v of violations) {
    lines.push(`  ${v.path}:${v.line}  '${v.code}'  (head '${v.head}')`);
  }
  lines.push(
    '',
    'Repair — register the code (ruling D11; there is no head-guessing fallback any more):',
    '  1. Add the definition to a catalog module, e.g.',
    '     packages/core/src/lib/errors/definitions/<domain>.ts',
    '  2. Add its module to CATALOG_SOURCES in scripts/extract-error-catalog-metadata.mjs',
    '     if the file is new.',
    '  3. Throw it with createToolError(catalog.require(<CODE>), message) instead of',
    "     passing a { code: '…' } string literal.",
    '  4. Run: pnpm docs:error-index',
  );
  return lines.join('\n');
}
