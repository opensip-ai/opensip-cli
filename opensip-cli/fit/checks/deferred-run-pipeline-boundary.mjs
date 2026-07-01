/**
 * @fileoverview deferred-run-pipeline-boundary — keep the host-owned run
 * pipeline as an explicit epic until it is promoted from backlog.
 *
 * The assessment consensus deliberately deferred RunCommandPipeline /
 * defineAnalysisRunCommand work until the P0/P1 contract fixes landed. This
 * guard prevents partial production APIs from appearing under those reserved
 * names without first promoting the deferred ADR into an implementation spec
 * and updating this check.
 */
import { defineCheck } from '@opensip-cli/fitness';

const PRODUCTION_TS = /(^|\/)packages\/.*\/src\/.*\.ts$/;
const TEST_OR_FIXTURE = /(^|\/)(?:__tests__|__fixtures__|fixtures)\//;
const TEST_FILE = /\.test\.ts$/;

const RESERVED_SYMBOLS = [
  'RunCommandPipeline',
  'defineAnalysisRunCommand',
  'readToolConfig',
  'readOptionalToolConfig',
  'RunLifecycleEvent',
  'UnitLifecycleEvent',
  'DeliveryLifecycleEvent',
  'ConfigLifecycleEvent',
];

const RESERVED_RE = new RegExp(`\\b(?:${RESERVED_SYMBOLS.join('|')})\\b`, 'u');

export const deferredRunPipelineBoundary = defineCheck({
  id: 'b6c8ef38-1d6f-4c7d-b49e-21eec3abf7bb',
  slug: 'deferred-run-pipeline-boundary',
  description:
    'Reserved host-owned run pipeline APIs must not appear before the backlog epic is promoted',
  scope: { languages: ['typescript'], concerns: ['architecture'] },
  tags: ['architecture'],
  fileTypes: ['ts'],
  // Match reserved API *symbols* in code only; a comment or string mentioning
  // the deferred names (e.g. a migration TODO or an ADR-0104 reference) is not a
  // premature implementation and must not fail the gate.
  contentFilter: 'strip-strings-and-comments',
  analyze: (content, filePath) => {
    const normalized = filePath.replaceAll('\\', '/');
    if (!PRODUCTION_TS.test(normalized)) return [];
    if (TEST_OR_FIXTURE.test(normalized) || TEST_FILE.test(normalized)) return [];

    const match = RESERVED_RE.exec(content);
    if (match === null) return [];

    return [
      {
        message: `Reserved run-pipeline API '${match[0]}' appears before the host-owned run pipeline epic is promoted.`,
        severity: 'error',
        suggestion:
          'Promote ADR-0104 into a ready/spec implementation plan, then update this guard with the approved package boundary.',
      },
    ];
  },
});
