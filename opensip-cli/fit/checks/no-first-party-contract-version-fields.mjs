/**
 * @fileoverview no-first-party-contract-version-fields — production code must
 *               declare runtime domain contract versions through the open
 *               `extensionPoints.contractVersions` map (ADR-0074), not closed
 *               first-party field names. Project-local SELF-check.
 */
import { defineCheck } from '@opensip-cli/fitness';

const CLOSED_FIELD_NAMES = [
  'fitnessContractVersion',
  'graphContractVersion',
  'simulationContractVersion',
  'yagniContractVersion',
];

const CLOSED_FIELD_RE = new RegExp(`\\b(?:${CLOSED_FIELD_NAMES.join('|')})\\b`);

const PRODUCTION_SRC_PATH = /^packages\/(?:[^/]+\/)+src\//;

function isExcludedPath(filePath) {
  const rel = filePath.replaceAll('\\', '/');
  return (
    /\/__tests__\//.test(rel) ||
    /\/__fixtures__\//.test(rel) ||
    /\/fixtures?\//.test(rel) ||
    /\.test\.tsx?$/.test(rel) ||
    /docs\/plans\//.test(rel)
  );
}

/** Pure analysis. Exported for unit tests. */
export function analyzeNoFirstPartyContractVersionFields(content, filePath) {
  const rel = filePath.replaceAll('\\', '/');
  if (!PRODUCTION_SRC_PATH.test(rel) || isExcludedPath(rel)) return [];

  const violations = [];
  const lines = content.split('\n');
  for (const [i, line] of lines.entries()) {
    const match = CLOSED_FIELD_RE.exec(line);
    if (!match) continue;
    violations.push({
      line: i + 1,
      filePath,
      message:
        `Closed first-party contract version field '${match[0]}' is not allowed ` +
        `in production source. Use extensionPoints.contractVersions[domainId] instead (ADR-0074).`,
      severity: 'error',
      suggestion:
        'Replace named fields with contractVersions: { fitness: FITNESS_CONTRACT_VERSION } ' +
        '(or graph/simulation/yagni as appropriate). Core must stay domain-agnostic.',
      type: 'no-first-party-contract-version-fields',
    });
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: 'd4e8f1a2-6b3c-4f9e-8d1a-2c3e4f5a6b7d',
    slug: 'no-first-party-contract-version-fields',
    description:
      'Production source must not declare closed first-party contract version fields; use extensionPoints.contractVersions',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'tool-contract', 'versioning', 'plugins'],
    fileTypes: ['ts', 'tsx'],
    analyze: (content, filePath) => analyzeNoFirstPartyContractVersionFields(content, filePath),
  }),
];
