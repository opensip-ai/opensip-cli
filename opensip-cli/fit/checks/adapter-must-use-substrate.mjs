/**
 * @fileoverview adapter-must-use-substrate — an External Tool Adapter package
 *   (packages/tool-gitleaks|osv-scanner|trivy/src/**) MUST build its `Tool` via
 *   `defineExternalToolAdapter` from `@opensip-cli/external-tool-adapter` and MUST
 *   NOT hand-roll the scanner loop. Project-local SELF-check.
 *
 * WHY this lives HERE (project-local .mjs), not in a shipped @opensip-cli/checks-*
 * pack: it is an opensip-internal structural invariant — it hardcodes the
 * first-party adapter package paths AND cites an opensip ADR (ADR-0090), so per
 * `opensip-cli/fit/checks/README.md` and the `shipped-checks-must-be-generic`
 * placement gate it must NOT ship (it is inert for any adopter who installs
 * opensip-cli and runs `fit` on their own code). Unlike the AST-dependent
 * `mcp-results-no-rerun` (which ships WITH a waiver only because a project-local
 * .mjs cannot import the TS-AST helpers it needs), this is a pure text/regex
 * import check with NO AST need — the policy steers a no-AST local-fact check to a
 * project-local .mjs, so there is no honest reason to ship it.
 *
 * ADR-0090 (external tool adapters are a worker-dispatched installed substrate):
 * the substrate `@opensip-cli/external-tool-adapter` owns binary resolution, the
 * SINGLE subprocess boundary (`execFile`, no shell — `process-exec.ts`), secret
 * redaction, provenance, and the auto-added doctor/version commands;
 * `defineExternalToolAdapter` returns `defineTool(...)`, so an adapter is an
 * ordinary `Tool` authored through the substrate. An adapter that imports
 * `node:child_process` (or calls `execFile`/`spawn`) is re-implementing the
 * substrate's subprocess loop; one that calls `defineTool` directly is bypassing
 * the substrate authoring helper. Both defeat the substrate's confidentiality +
 * isolation guarantees, so both are violations.
 *
 * Path-gated to the three first-party adapter packages ONLY — NOT the substrate
 * (which legitimately owns subprocess execution) and NOT `tool-test-kit`
 * (a layer-2 published helper, Risk R8). contentFilter is `raw`, and the analyzer
 * strips COMMENTS ITSELF (preserving strings) before matching: the `child_process`
 * module specifier lives in a STRING literal, so the engine's strip-strings filter
 * would erase the very token we match, while comment prose mentioning `execFile(`
 * or `defineTool` must NOT fire. A string-preserving comment strip is the only
 * filter that satisfies both.
 */
import { defineCheck } from '@opensip-cli/fitness';

/**
 * Strip `//` line + `/* *\/` block comments while preserving string/template
 * contents (so the `child_process` module specifier survives) — a tiny scanner
 * tracking string state with escapes. Regex/division `/` is emitted verbatim
 * (only `//` and `/*` begin a comment), which is correct for the adapter sources.
 */
function stripComments(src) {
  let out = '';
  let str = null;
  for (let i = 0; i < src.length; ) {
    const ch = src[i];
    if (str !== null) {
      out += ch;
      if (ch === '\\' && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === str) str = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      str = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** The first-party External Tool Adapter source trees (ADR-0090 MVP set). */
const ADAPTER_SRC = /packages\/tool-(?:gitleaks|osv-scanner|trivy)\/src\//;

/** Tests/fixtures are not adapter runtime source. */
const NON_SOURCE = /\.test\.tsx?$|\/__tests__\/|\/__fixtures__\//;

/**
 * A direct `child_process` import (static `from`, `require(...)`, or dynamic
 * `import(...)`), with or without the `node:` prefix. The substrate owns the
 * single subprocess boundary, so an adapter never imports it.
 */
const CHILD_PROCESS_IMPORT =
  /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"](?:node:)?child_process['"]/;

/**
 * A subprocess CALL idiom (the `execFile`/`spawn` family, paren-required). In the
 * real adapters `execFile` appears only in prose comments (`… via execFile —`),
 * never as a call, so requiring `(` keeps those comments from firing.
 */
const SUBPROCESS_CALL = /\b(?:execFile|execFileSync|spawn|spawnSync)\s*\(/;

/**
 * A raw `defineTool` import or call. `defineExternalToolAdapter` does NOT contain
 * the substring `defineTool` (it is `define` + `External…`), so this fires only on
 * a genuine hand-rolled `defineTool`.
 */
const DEFINE_TOOL = /\bdefineTool\b/;

export function analyzeAdapterMustUseSubstrate(content, filePath) {
  const norm = String(filePath).replaceAll('\\', '/');
  if (!ADAPTER_SRC.test(norm) || NON_SOURCE.test(norm)) return [];

  // Match on code only — a comment that describes execFile/defineTool/child_process
  // (as the real adapters' prose does) must not fire; the child_process specifier
  // string is preserved by the strip so the import is still detectable.
  const code = stripComments(content);
  const reasons = [];
  if (CHILD_PROCESS_IMPORT.test(code) || SUBPROCESS_CALL.test(code)) {
    reasons.push('imports or calls node:child_process (execFile/spawn) directly');
  }
  if (DEFINE_TOOL.test(code)) {
    reasons.push('uses defineTool directly instead of defineExternalToolAdapter');
  }
  if (reasons.length === 0) return [];

  return [
    {
      line: 1,
      filePath: norm,
      message:
        `External Tool Adapter source ${reasons.join('; ')}. An adapter MUST build its Tool via ` +
        `defineExternalToolAdapter from @opensip-cli/external-tool-adapter — the substrate owns ` +
        `binary resolution, the single execFile subprocess boundary (no shell), secret redaction, ` +
        `provenance, and the doctor/version commands; hand-rolling the scanner loop defeats those ` +
        `guarantees.`,
      severity: 'error',
      suggestion:
        `Author the adapter through defineExternalToolAdapter(...) (model on ` +
        `packages/tool-gitleaks/src/tool.ts) and declare the scanner binary via the binary ` +
        `descriptor. Never import node:child_process, call execFile/spawn, or call defineTool from ` +
        `an adapter package — the substrate is the only place that runs the subprocess.`,
      type: 'adapter-must-use-substrate',
    },
  ];
}

export const checks = [
  defineCheck({
    id: 'f3218b18-f8a1-4714-b9c9-6430c4de1016',
    slug: 'adapter-must-use-substrate',
    description:
      'External Tool Adapter packages must build their Tool via defineExternalToolAdapter and must not hand-roll the scanner loop (no direct node:child_process/execFile/spawn, no raw defineTool)',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'tools', 'adapters'],
    fileTypes: ['ts'],
    // raw: the `child_process` module specifier lives in a string literal, so the
    // engine's strip-strings filter would erase the matched token. The analyzer
    // strips COMMENTS itself (preserving strings) so prose mentioning execFile/
    // defineTool cannot false-fire — the one filter the built-ins don't offer.
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeAdapterMustUseSubstrate(content, filePath),
  }),
];
