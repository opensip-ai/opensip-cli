/**
 * tool-engine-no-direct-stderr-command-errors — handler-time command failures in
 * first-party tool engines must route through ToolCliContext.reportFailure (or
 * host catch of ToolError), not direct process.stderr.write (Plan 06 / ADR-0077).
 */
import { defineCheck } from '@opensip-cli/fitness';

import { isSeamExempt } from '../../../scripts/load-seam-exemptions.mjs';

const ENFORCED_PATH = /packages\/(fitness|graph|simulation|yagni)\/engine\/src\/cli\//;

const TEST_PATH = /(?:\.test\.tsx?$|\/__tests__\/)/;

/** Progress, worker transport, and warning channels — not customer command errors. */
const ALLOWLIST = [
  /packages\/fitness\/engine\/src\/cli\/fit-modes\.ts$/,
  /packages\/graph\/engine\/src\/cli\/heap-preflight\.ts$/,
  /packages\/graph\/engine\/src\/cli\/graph-workspace-mode\.ts$/,
  /packages\/graph\/engine\/src\/cli\/shard-worker\.ts$/,
];

const STDERR_PATTERN = /\bprocess\.stderr\.write\s*\(/;

export function analyzeToolEngineStderrCommandErrors(content, filePath) {
  if (!ENFORCED_PATH.test(filePath)) return [];
  if (TEST_PATH.test(filePath)) return [];
  if (ALLOWLIST.some((re) => re.test(filePath))) return [];
  if (isSeamExempt(filePath, 'tool-engine-no-direct-stderr-command-errors')) return [];

  const violations = [];
  for (const [i, line] of content.split('\n').entries()) {
    if (STDERR_PATTERN.test(line)) {
      violations.push({
        message:
          'Tool engine command errors must use cli.reportFailure (or throw ToolError for the host mount catch). Direct process.stderr.write is reserved for warnings/progress/worker transport allowlisted paths.',
        suggestion:
          'Replace with await cli.reportFailure({ message, exitCode, jsonRequested }) or add a path allowlist entry with justification if this is progress/transport stderr.',
        severity: 'error',
        line: i + 1,
      });
    }
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: 'a3f9c2e1-4b8d-4f6a-9c0e-1d2e3f4a5b6c',
    slug: 'tool-engine-no-direct-stderr-command-errors',
    description:
      'First-party tool engine CLI handlers must not write customer-facing command errors directly to stderr; use ToolCliContext.reportFailure.',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'quality'],
    fileTypes: ['ts', 'tsx'],
    contentFilter: 'strip-strings',
    analyze: (content, filePath) => analyzeToolEngineStderrCommandErrors(content, filePath),
  }),
];
