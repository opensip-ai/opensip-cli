/**
 * @fileoverview session-persist-requires-replay — a first-party tool that
 * persists generic sessions must also declare sessionReplay so stored rows are
 * useful to `sessions show` and MCP result readers.
 */
import { defineCheck } from '@opensip-cli/fitness';

import { toolEnginePathRe, toolPackageSegmentForPath } from './tool-engine-paths.mjs';

const TOOL_ENGINE_PATH = toolEnginePathRe();
const SESSION_PERSIST_RE = /\bToolSessionContribution\b|\bbuild[A-Za-z]+SessionPayload\b/;
const SESSION_REPLAY_RE = /\bsessionReplay\s*:/;

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

export async function analyzeAllSessionPersistRequiresReplay(files) {
  const descriptors = new Map();
  const sessionWriters = new Map();
  const candidates = files.paths.filter(
    (path) => path.endsWith('.ts') && TOOL_ENGINE_PATH.test(relPath(path)) && !isTestOrFixture(path),
  );
  const contents = await files.readMany(candidates);

  for (const [filePath, content] of contents) {
    const rel = relPath(filePath);
    const segment = toolPackageSegmentForPath(rel);
    if (segment === undefined) continue;
    if (rel.endsWith('/tool.ts')) {
      descriptors.set(segment, { filePath, content });
    }
    if (SESSION_PERSIST_RE.test(content) && !sessionWriters.has(segment)) {
      sessionWriters.set(segment, {
        filePath,
        line: lineOfNeedle(content, 'SessionPayload'),
      });
    }
  }

  const violations = [];
  for (const [segment, writer] of sessionWriters) {
    const descriptor = descriptors.get(segment);
    if (descriptor !== undefined && SESSION_REPLAY_RE.test(descriptor.content)) continue;
    violations.push({
      filePath: descriptor?.filePath ?? writer.filePath,
      line:
        descriptor === undefined
          ? writer.line
          : lineOfNeedle(descriptor.content, 'extensionPoints'),
      type: 'session-persist-requires-replay',
      message: `First-party tool '${segment}' persists sessions but does not declare extensionPoints.sessionReplay.`,
      severity: 'error',
      suggestion:
        'Add a replaySession implementation and wire it under defineTool({ extensionPoints: { sessionReplay: ... } }).',
    });
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: '0a418e5d-7e22-4054-a016-e43ee9e12847',
    slug: 'session-persist-requires-replay',
    description: 'First-party tools that persist sessions declare sessionReplay',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture'],
    fileTypes: ['ts'],
    contentFilter: 'raw',
    analyzeAll: analyzeAllSessionPersistRequiresReplay,
  }),
];
