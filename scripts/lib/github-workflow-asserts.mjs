/**
 * Shared regex helpers for workflow-structure unit tests (Plan 10 / ADR-0168).
 * Assert *shape* only — never literal SHAs — so Dependabot pin bumps do not
 * require lockstep test edits.
 *
 * @module scripts/lib/github-workflow-asserts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Match `uses: owner/name@ref` (ref may be tag or 40-char SHA). */
export const SHA_PIN = /uses:\s*[^@\s#]+@([^\s#]+)/g;

/** Full git commit SHA (40 lowercase hex). */
export const FULL_SHA = /^[a-f0-9]{40}$/;

/**
 * Strip `# …` comments so string/regex asserts ignore documentation pins in
 * comment blocks. Does not implement a full YAML parser.
 * @param {string} text
 */
export function stripComments(text) {
  return text
    .split('\n')
    .map((line) => {
      // Keep quoted strings intact enough for our simple tests: drop trailing
      // unquoted # comments only when not inside a single-quoted cron etc.
      const hash = line.indexOf('#');
      if (hash < 0) return line;
      const before = line.slice(0, hash);
      if ((before.match(/'/g) || []).length % 2 === 1) return line;
      if ((before.match(/"/g) || []).length % 2 === 1) return line;
      return before;
    })
    .join('\n');
}

/**
 * @param {string} relativePath path under .github/workflows/ or absolute under .github/
 */
export function readWorkflow(relativePath) {
  const path = relativePath.startsWith('.github/')
    ? join(REPO_ROOT, relativePath)
    : join(REPO_ROOT, '.github', 'workflows', relativePath);
  return readFileSync(path, 'utf8');
}

/**
 * Collect action refs from workflow text (comment-stripped recommended).
 * @param {string} wf
 * @returns {string[]}
 */
export function collectActionRefs(wf) {
  return [...wf.matchAll(SHA_PIN)].map((m) => m[1]);
}

/**
 * Assert every third-party uses: pin is a full 40-char SHA. Local
 * `./.github/...` composite actions are skipped (no @sha).
 * @param {string} raw
 * @param {(msg: string) => void} [fail]
 */
export function assertThirdPartyActionsPinned(
  raw,
  fail = (msg) => {
    throw new Error(msg);
  },
) {
  const lines = stripComments(raw).split('\n');
  for (const line of lines) {
    const m = /uses:\s*(\S+)/.exec(line);
    if (!m) continue;
    const spec = m[1];
    if (spec.startsWith('./') || spec.startsWith('.github/')) continue;
    const at = spec.lastIndexOf('@');
    if (at < 0) {
      fail(`action ${spec} must pin @<40-char-sha>`);
      continue;
    }
    const ref = spec.slice(at + 1);
    if (!FULL_SHA.test(ref)) {
      fail(`action ref ${ref} must be a full 40-char commit SHA, not a tag`);
    }
  }
}
