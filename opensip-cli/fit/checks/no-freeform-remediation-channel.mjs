/**
 * @fileoverview no-freeform-remediation-channel — first-party tool findings
 * must expose remediation through signal.repair, not ad hoc metadata fields.
 */
import { defineCheck } from '@opensip-cli/fitness';

const FREEFORM_REMEDIATION_RE = /\bsuggestedAction\s*:/g;

function relPath(filePath) {
  return String(filePath).replaceAll('\\', '/');
}

function isTestOrFixture(filePath) {
  const rel = relPath(filePath);
  return (
    /\/__tests__\//.test(rel) ||
    /\/__fixtures__\//.test(rel) ||
    /\/fixtures?\//.test(rel) ||
    /\.test\.tsx?$/.test(rel)
  );
}

function isFirstPartyToolSource(filePath) {
  const rel = relPath(filePath);
  return (
    /(?:^|\/)packages\/(?:fitness|graph|simulation|yagni)\/[^/]+\/src\/.*\.ts$/.test(rel) &&
    !isTestOrFixture(rel)
  );
}

function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

export async function analyzeAllNoFreeformRemediationChannel(files) {
  const candidates = files.paths.filter(isFirstPartyToolSource);
  const contents = await files.readMany(candidates);
  const violations = [];

  for (const [filePath, content] of contents) {
    FREEFORM_REMEDIATION_RE.lastIndex = 0;
    let match;
    while ((match = FREEFORM_REMEDIATION_RE.exec(content)) !== null) {
      violations.push({
        filePath,
        line: lineOf(content, match.index),
        type: 'no-freeform-remediation-channel',
        message:
          'First-party tool findings must not author freeform remediation fields such as suggestedAction.',
        severity: 'error',
        suggestion:
          'Put remediation on signal.repair (SignalRepair.patchHint/repairKind/confidence) and keep tool metadata for evidence/classification only.',
      });
    }
  }

  return violations;
}

export const checks = [
  defineCheck({
    id: 'e4549659-bc5a-4d0c-9701-46f2b59fb509',
    slug: 'no-freeform-remediation-channel',
    description: 'First-party findings route remediation through signal.repair',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'signals', 'repair'],
    fileTypes: ['ts'],
    contentFilter: 'strip-strings-and-comments',
    analyzeAll: analyzeAllNoFreeformRemediationChannel,
  }),
];
