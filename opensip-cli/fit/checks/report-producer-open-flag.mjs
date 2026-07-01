/**
 * @fileoverview report-producer-open-flag — tools that contribute dashboard
 * data must either expose the host-owned --open flag or document an explicit
 * opt-out.
 */
import { defineCheck } from '@opensip-cli/fitness';

import { toolEnginePathRe, toolPackageSegmentForPath } from './tool-engine-paths.mjs';

const TOOL_ENGINE_PATH = toolEnginePathRe();
const COLLECT_REPORT_RE = /\bcollectReportData\b\s*[:,}]/;
const OPEN_COMMON_FLAG_RE = /commonFlags\s*:\s*\[[\s\S]*?['"]open['"][\s\S]*?\]/;
const OPT_OUT_RE = /\breport-open-opt-out\b/;

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

function lineOfNeedle(content, needle) {
  const index = content.indexOf(needle);
  if (index < 0) return 1;
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

export async function analyzeAllReportProducerOpenFlag(files) {
  const producers = new Map();
  const openFlagSegments = new Set();
  const optOutSegments = new Set();
  const candidates = files.paths.filter(
    (path) =>
      path.endsWith('.ts') && TOOL_ENGINE_PATH.test(relPath(path)) && !isTestOrFixture(path),
  );
  const contents = await files.readMany(candidates);

  for (const [filePath, content] of contents) {
    const rel = relPath(filePath);
    const segment = toolPackageSegmentForPath(rel);
    if (segment === undefined) continue;
    if (rel.endsWith('/tool.ts') && COLLECT_REPORT_RE.test(content)) {
      producers.set(segment, { filePath, content });
    }
    if (OPEN_COMMON_FLAG_RE.test(content)) {
      openFlagSegments.add(segment);
    }
    if (OPT_OUT_RE.test(content)) {
      optOutSegments.add(segment);
    }
  }

  const violations = [];
  for (const [segment, producer] of producers) {
    if (openFlagSegments.has(segment) || optOutSegments.has(segment)) continue;
    violations.push({
      filePath: producer.filePath,
      line: lineOfNeedle(producer.content, 'collectReportData'),
      type: 'report-producer-open-flag',
      message: `First-party tool '${segment}' contributes collectReportData but does not expose --open.`,
      severity: 'error',
      suggestion:
        "Add 'open' to the primary run command's commonFlags array, or document a report-open-opt-out in the tool command source.",
    });
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: '55ebd03f-d4e0-46f1-93ab-49cc42353cfd',
    slug: 'report-producer-open-flag',
    description: 'First-party tools that contribute report data expose --open or opt out',
    scope: { languages: ['typescript'], concerns: ['backend', 'cli'] },
    tags: ['architecture', 'dogfood'],
    fileTypes: ['ts'],
    contentFilter: 'raw',
    analyzeAll: analyzeAllReportProducerOpenFlag,
  }),
];
