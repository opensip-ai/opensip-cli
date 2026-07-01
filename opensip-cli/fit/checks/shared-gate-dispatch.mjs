/**
 * @fileoverview shared-gate-dispatch — production tool gate paths must use the
 * shared host gate-dispatch helper instead of hand-rolling baseline save/compare
 * tails. Project-local SELF-check.
 *
 * The baseline plane is host-owned (ADR-0036). Tools may produce a stamped
 * envelope and tool-specific render lines, but the repeated save/compare →
 * render → deliver/SARIF choreography belongs in `runHostGateDispatch` from
 * `@opensip-cli/contracts`. This check prevents the former per-tool drift from
 * reappearing in first-party tool engines or the external adapter substrate.
 */
import { defineCheck } from '@opensip-cli/fitness';

import { toolEnginePathRe } from './tool-engine-paths.mjs';

const TOOL_ENGINE_TS_PATH = toolEnginePathRe('.*\\.ts$');
const EXTERNAL_ADAPTER_TS_PATH = /packages\/external-tool-adapter\/src\/.*\.ts$/;
const TEST_PATH = /(?:\.test\.tsx?$|\/__tests__\/)/;
const DIRECT_BASELINE_SEAM_RE = /\bcli\.(?:saveBaseline|compareBaseline)\s*\(/;

function isCheckedPath(filePath) {
  return TOOL_ENGINE_TS_PATH.test(filePath) || EXTERNAL_ADAPTER_TS_PATH.test(filePath);
}

export function analyzeSharedGateDispatch(content, filePath) {
  if (!isCheckedPath(filePath) || TEST_PATH.test(filePath)) return [];
  const violations = [];
  for (const [index, line] of content.split('\n').entries()) {
    if (!DIRECT_BASELINE_SEAM_RE.test(line)) continue;
    violations.push({
      message:
        'Tool gate code must use runHostGateDispatch(...) instead of calling baseline save/compare seams directly.',
      severity: 'error',
      line: index + 1,
      suggestion:
        'Import runHostGateDispatch from @opensip-cli/contracts and keep only tool-specific execution and render-line construction in the tool.',
    });
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: 'a7e8d6f2-8bbf-4a48-932e-c6f3bdb57406',
    slug: 'shared-gate-dispatch',
    description:
      'Tool gate paths must use the shared host gate-dispatch helper for baseline save/compare tails',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture'],
    fileTypes: ['ts'],
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeSharedGateDispatch(content, filePath),
  }),
];
