/**
 * @fileoverview declared-inputs-host-stamped-only — the `declaredInputs` manifest
 * on a SignalEnvelope is HOST-stamped, never tool-stamped (ADR-0097, gate-verdict
 * determinism).
 *
 * A persisted/emitted gate verdict carries an allowlisted `declaredInputs`
 * manifest (CLI/Node/platform/tool versions, package-manager identity, baseline
 * fingerprint) that must NOT include env dumps, absolute project paths, secrets,
 * or mutable hidden host state. The single authority that stamps it is the host
 * bootstrap seam (`packages/cli/src/bootstrap/declared-inputs.ts`). A TOOL ENGINE
 * that stamps its own `declaredInputs` could smuggle unbounded/host-specific state
 * into the evidence and break determinism, so tool-engine source must never assign
 * the field — it leaves it unset and the host stamps the bounded manifest.
 *
 * This is an opensip-cli-specific dogfood check (project-local): the boundary keys
 * on first-party engine/adapter package paths.
 */
import { defineCheck } from '@opensip-cli/fitness';

import { toolSeamPathRe } from './tool-engine-paths.mjs';

/** First-party TOOL-ENGINE / adapter source — builds envelopes, must not stamp. */
const TOOL_ENGINE = toolSeamPathRe();
/** Graph language adapters may also construct envelopes (not opensipTools tools). */
const GRAPH_ADAPTER = /packages\/graph\/graph-[a-z-]+\/src\//;

/** Test/fixture files are not runtime source. */
const NON_SOURCE = /\.test\.tsx?$|\/__tests__\//;

/** A VALUE assignment of `declaredInputs` (`declaredInputs: <expr>`), not a type
 *  declaration (`declaredInputs?: DeclaredInputs`) nor a read (`.declaredInputs`). */
const STAMP = /(^|[^.\w])declaredInputs\s*:/;

function relPath(filePath) {
  return String(filePath).replaceAll('\\', '/');
}

function isToolEnginePath(rel) {
  return TOOL_ENGINE.test(rel) || GRAPH_ADAPTER.test(rel);
}

export const checks = [
  defineCheck({
    id: 'c1f0a7e2-3b58-4d9a-a6c4-2e9b7d10f584',
    slug: 'declared-inputs-host-stamped-only',
    description:
      'Tool engines must not stamp SignalEnvelope.declaredInputs — the host stamps the allowlisted manifest (ADR-0097).',
    scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
    tags: ['architecture', 'quality'],
    fileTypes: ['ts'],
    contentFilter: 'strip-strings-and-comments',
    analyze(content, filePath) {
      const rel = relPath(filePath);
      if (NON_SOURCE.test(rel)) return [];
      if (!isToolEnginePath(rel)) return [];

      const violations = [];
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (STAMP.test(lines[i])) {
          violations.push({
            filePath,
            line: i + 1,
            type: 'declared-inputs-host-stamped-only',
            message:
              'Tool-engine source must not stamp SignalEnvelope.declaredInputs — the host stamps the bounded, allowlisted manifest (ADR-0097).',
            severity: 'error',
            suggestion:
              'Leave declaredInputs unset on the tool envelope; the host bootstrap (declared-inputs.ts) stamps the allowlisted manifest.',
          });
        }
      }
      return violations;
    },
  }),
];
