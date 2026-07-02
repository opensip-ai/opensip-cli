/**
 * @fileoverview review-brief-correlation-shared-helper — live suite review and
 * MCP persisted review must use the same correlation join helper.
 *
 * This is an opensip-cli-specific dogfood check for ADR-0124. It hardcodes the
 * two first-party review-brief composition roots so the live CLI surface and
 * persisted MCP read port cannot grow separate correlation implementations.
 */
import path from 'node:path';

import { defineCheck } from '@opensip-cli/fitness';

const TARGETS = [
  'packages/cli/src/commands/suite/review-brief-builder.ts',
  'packages/mcp/src/persisted-review-brief.ts',
];

const HELPER_NAME = 'buildReviewBriefCorrelations';
const LOCAL_CORRELATION_RE =
  /\b(?:function|const|let)\s+(?:build\w*Correlation\w*|group\w*Risk\w*)\b/i;

function relPath(filePath) {
  const normalized = String(filePath).replaceAll('\\', '/');
  if (!path.isAbsolute(normalized)) return normalized;
  return path.relative(process.cwd(), normalized).replaceAll('\\', '/');
}

function lineOfNeedle(content, needle) {
  const index = content.search(needle);
  if (index < 0) return 1;
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

function hasHelperCall(content) {
  return new RegExp(`\\b${HELPER_NAME}\\s*\\(`).test(content);
}

export async function analyzeAllReviewBriefCorrelationSharedHelper(files) {
  const candidates = files.paths.filter((path) => TARGETS.includes(relPath(path)));
  const contents = new Map(await files.readMany(candidates));
  const violations = [];

  for (const target of TARGETS) {
    const entry = [...contents.entries()].find(([filePath]) => relPath(filePath) === target);
    if (entry === undefined) {
      violations.push({
        filePath: target,
        line: 1,
        type: 'review-brief-correlation-shared-helper',
        message: `${target} is missing from the review-brief correlation guardrail targets.`,
        severity: 'error',
        suggestion:
          'Update the guardrail target or restore the review-brief composition root from ADR-0124.',
      });
      continue;
    }

    const [filePath, content] = entry;
    if (!content.includes(HELPER_NAME) || !hasHelperCall(content)) {
      violations.push({
        filePath,
        line: 1,
        type: 'review-brief-correlation-shared-helper',
        message: `${target} must build correlatedRisks via ${HELPER_NAME} from @opensip-cli/contracts.`,
        severity: 'error',
        suggestion:
          'Import buildReviewBriefCorrelations from @opensip-cli/contracts and call it on the ordered review risks.',
      });
    }

    if (LOCAL_CORRELATION_RE.test(content)) {
      violations.push({
        filePath,
        line: lineOfNeedle(content, LOCAL_CORRELATION_RE),
        type: 'review-brief-correlation-shared-helper',
        message: `${target} must not define local review-risk grouping or correlation builders.`,
        severity: 'error',
        suggestion:
          'Move shared correlation logic to packages/contracts/src/review-brief-correlation.ts.',
      });
    }
  }

  return violations;
}

export const checks = [
  defineCheck({
    id: 'a048b2df-17a2-4d35-8a31-73ff2f21f7fb',
    slug: 'review-brief-correlation-shared-helper',
    description:
      'Live suite and persisted MCP review briefs share the contracts correlation helper',
    scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
    tags: ['architecture', 'quality'],
    fileTypes: ['ts'],
    contentFilter: 'raw',
    analyzeAll: analyzeAllReviewBriefCorrelationSharedHelper,
  }),
];
