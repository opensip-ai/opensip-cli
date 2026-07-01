/**
 * @fileoverview cross-tool-flag-parity — cross-tool common CLI flags must come
 *               from the shared registry and primary run commands must retain
 *               the shared reporting surface. Project-local SELF-check.
 *
 * Relocated out of `@opensip-cli/checks-universal` (placement sweep) because it
 * encodes opensip-cli local facts: it hardcodes the first-party tool-engine
 * paths (`packages/{fitness,graph,simulation,yagni}/engine/src/**`), the ADR-0021
 * `commonFlags` registry seam in `@opensip-cli/contracts`, and the exact
 * registry-owned long-flag set (`--json`, `--cwd`, `--quiet`, `--verbose`,
 * `--debug`, `--report-to`, `--api-key`, `--open`). A consumer repo whose
 * Commander CLI legitimately declares `--json` etc. does not share that
 * architecture, so the rule is opensip-internal, not universal. Inert for
 * adopters per opensip-cli/fit/checks/README.md.
 *
 * WHY (ADR-0021, "cross-tool CLI flag currency"): the flags every tool's run
 * command shares are declared ONCE in `@opensip-cli/contracts` (`commonFlags`)
 * and applied via `applyCommonFlags`. Hand-declaring one with a raw
 * `.option('--json', ...)` in a tool registration file reintroduces the
 * per-tool duplication that already drifted (`--report-to` read three different
 * ways before the registry). This check fires on that raw declaration so the
 * parity cannot silently regress.
 *
 * Positive parity — that each primary verdict-producing run command actually
 * DECLARES the mandatory reporting set — is enforced here too. `definePrimaryRunCommand`
 * is the preferred path; a manual primary command must include every required
 * common flag key explicitly or through the shared constants.
 *
 * SCOPE — opensip-cli's own tool-engine files only
 * (`packages/{fitness,graph,simulation,yagni}/engine/src/**`). The path guard
 * makes it inert in adopter repos — it enforces THIS platform's architecture,
 * not a universal rule.
 */
import { defineCheck } from '@opensip-cli/fitness';

import { toolEnginePathRe } from './tool-engine-paths.mjs';

/** Resolved-path fragment identifying a first-party tool engine TypeScript file. */
const TOOL_ENGINE_TS_PATH = toolEnginePathRe('.*\\.ts$');

/** Long flags owned by the ADR-0021 registry — a raw `.option(...)` for any of
 *  these bypasses `applyCommonFlags`. */
const REGISTRY_LONG_FLAGS = new Set([
  '--json',
  '--cwd',
  '--quiet',
  '--verbose',
  '--debug',
  '--report-to',
  '--api-key',
  '--open',
]);

/** Required common flag keys for primary reporting run commands. */
const REPORTING_RUN_COMMON_FLAG_KEYS = [
  'json',
  'cwd',
  'quiet',
  'verbose',
  'debug',
  'reportTo',
  'apiKey',
  'open',
];

/** Captures the first string argument of a `.option(...)` call (the flag spec). */
const OPTION_LITERAL_RE = /\.option\(\s*['"]([^'"]+)['"]/;

/** Captures a literal `commonFlags: [...]` array. */
const COMMON_FLAGS_ARRAY_RE = /commonFlags\s*:\s*\[([\s\S]*?)\]/g;

/** Captures a direct shared-constant commonFlags assignment. */
const COMMON_FLAGS_CONSTANT_RE =
  /commonFlags\s*:\s*(REPORTING_RUN_COMMON_FLAGS|MANDATORY_COMMON_FLAGS)\b/;

/**
 * Pure analysis function. Exported so unit tests can exercise the detection
 * without the full Check framework. Flags each `.option('<common-flag>', ...)`
 * whose long flag is registry-owned.
 */
export function analyzeCrossToolFlagParity(content) {
  const violations = [];
  const lines = content.split('\n');
  for (const [index, line] of lines.entries()) {
    const match = OPTION_LITERAL_RE.exec(line);
    if (!match) continue;
    const longFlag = /--[a-z][a-z-]*/.exec(match[1])?.[0];
    if (longFlag === undefined || !REGISTRY_LONG_FLAGS.has(longFlag)) continue;
    violations.push({
      message: `Common flag '${longFlag}' is hand-declared via .option(...); cross-tool flags must come from the shared registry (ADR-0021).`,
      severity: 'error',
      line: index + 1,
      suggestion: `Apply it via applyCommonFlags(cmd, [...keys]) from @opensip-cli/contracts instead of a raw .option('${longFlag}' ...).`,
    });
  }
  return violations;
}

function addSharedCommonFlagsFromText(text, flags) {
  if (/\bREPORTING_RUN_COMMON_FLAGS\b/.test(text)) {
    for (const key of REPORTING_RUN_COMMON_FLAG_KEYS) flags.add(key);
    return;
  }
  if (/\bMANDATORY_COMMON_FLAGS\b/.test(text)) {
    for (const key of REPORTING_RUN_COMMON_FLAG_KEYS.filter((key) => key !== 'open')) {
      flags.add(key);
    }
  }
}

function declaredCommonFlagKeys(content) {
  const flags = new Set();
  addSharedCommonFlagsFromText(COMMON_FLAGS_CONSTANT_RE.exec(content)?.[1] ?? '', flags);
  for (const match of content.matchAll(COMMON_FLAGS_ARRAY_RE)) {
    const body = match[1] ?? '';
    addSharedCommonFlagsFromText(body, flags);
    for (const [, key] of body.matchAll(/['"]([a-zA-Z][a-zA-Z0-9]*)['"]/g)) {
      flags.add(key);
    }
  }
  return flags;
}

function hasPrimaryRunPreset(content) {
  return content.includes('definePrimaryRunCommand');
}

function hasManualPrimaryRunCommand(content) {
  return (
    content.includes('definePrimaryCommand') &&
    (content.includes("rawStreamReason: 'runtime-render-dispatch'") ||
      content.includes('rawStreamReason: "runtime-render-dispatch"') ||
      content.includes('producesVerdict: true'))
  );
}

/**
 * Pure analysis function. Exported so unit tests can prove primary run command
 * parity without executing the Check framework.
 */
export function analyzeMandatoryRunCommonFlags(content) {
  if (hasPrimaryRunPreset(content) || !hasManualPrimaryRunCommand(content)) {
    return [];
  }
  const declared = declaredCommonFlagKeys(content);
  const missing = REPORTING_RUN_COMMON_FLAG_KEYS.filter((key) => !declared.has(key));
  if (missing.length === 0) return [];
  return [
    {
      message: `Primary verdict-producing run command is missing shared reporting common flag(s): ${missing.join(', ')}.`,
      severity: 'error',
      suggestion:
        'Use definePrimaryRunCommand(...) from @opensip-cli/contracts, or include the full REPORTING_RUN_COMMON_FLAGS baseline.',
    },
  ];
}

export const checks = [
  defineCheck({
    id: '534bf31f-41a2-4bec-b0a7-c08205770db1',
    slug: 'cross-tool-flag-parity',
    description:
      'Cross-tool common CLI flags must come from the shared registry, not be hand-declared (ADR-0021)',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture'],
    fileTypes: ['ts'],
    // raw content: the flag specs we detect ARE string literals, so they must not
    // be stripped. The regex requires `.option(` immediately before the literal,
    // so prose mentioning a flag does not false-fire.
    contentFilter: 'raw',
    analyze: (content, filePath) => {
      if (!TOOL_ENGINE_TS_PATH.test(filePath)) return [];
      return [...analyzeCrossToolFlagParity(content), ...analyzeMandatoryRunCommonFlags(content)];
    },
  }),
];
