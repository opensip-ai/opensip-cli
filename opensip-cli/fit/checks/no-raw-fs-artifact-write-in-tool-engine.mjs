/**
 * no-raw-fs-artifact-write-in-tool-engine — durable tool artifacts must go
 * through ToolCliContext.writeArtifact so the host owns locking, atomic rename,
 * and persist diagnostics (ADR-0080).
 */
import { defineCheck } from '@opensip-cli/fitness';

import { isSeamExempt } from '../../../scripts/load-seam-exemptions.mjs';
import { toolEnginePathRe } from './tool-engine-paths.mjs';

const TOOL_ENGINE_PATH = toolEnginePathRe();
const TEST_PATH = /(?:\.test\.tsx?$|\/__tests__\/)/;

const EPHEMERAL_OR_DIAGNOSTIC_ALLOWLIST = [
  /packages\/fitness\/engine\/src\/cli\/fit-runner\.tsx$/,
  /packages\/simulation\/engine\/src\/cli\/sim-runner\.tsx$/,
  /packages\/graph\/engine\/src\/cli\/graph-runner\.tsx$/,
  /packages\/graph\/engine\/src\/cli\/orchestrate\/shard-runner\.ts$/,
  /packages\/graph\/engine\/src\/cli\/orchestrate\/resolution-trace\.ts$/,
  /packages\/graph\/engine\/src\/cli\/profile\.ts$/,
  /packages\/graph\/engine\/src\/cli\/equivalence-check-command\.ts$/,
];

const RAW_FS_WRITE_PATTERNS = [
  /\bwriteFileSync\s*\(/,
  /\bappendFileSync\s*\(/,
  /\bmkdirSync\s*\(/,
  /\bfs\.writeFile\s*\(/,
  /\bfs\.appendFile\s*\(/,
  /\bfs\.mkdir\s*\(/,
  /\bcreateWriteStream\s*\(/,
];

export function analyzeNoRawFsArtifactWrite(content, filePath) {
  const norm = filePath.replaceAll('\\', '/');
  if (!TOOL_ENGINE_PATH.test(norm)) return [];
  if (TEST_PATH.test(norm)) return [];
  if (EPHEMERAL_OR_DIAGNOSTIC_ALLOWLIST.some((re) => re.test(norm))) return [];
  if (isSeamExempt(norm, 'no-raw-fs-artifact-write-in-tool-engine')) return [];

  const violations = [];
  for (const [i, line] of content.split('\n').entries()) {
    if (!RAW_FS_WRITE_PATTERNS.some((re) => re.test(line))) continue;
    violations.push({
      message:
        'Tool engines must not write durable artifacts through raw fs calls; use cli.writeArtifact so the host applies atomic write, file locking, and persist diagnostics.',
      suggestion:
        'Replace raw fs writes with await cli.writeArtifact(path, bytes), or add @fitness-ignore-file no-raw-fs-artifact-write-in-tool-engine with a justification for ephemeral diagnostics/transport.',
      severity: 'error',
      line: i + 1,
      type: 'no-raw-fs-artifact-write-in-tool-engine',
    });
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: 'e1a6b618-7d1d-4c64-9d54-b8cf1cc5b2c1',
    slug: 'no-raw-fs-artifact-write-in-tool-engine',
    description:
      'First-party tool engines must write durable artifacts through cli.writeArtifact, not raw fs calls',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'persistence'],
    fileTypes: ['ts', 'tsx'],
    contentFilter: 'strip-strings',
    analyze: (content, filePath) => analyzeNoRawFsArtifactWrite(content, filePath),
  }),
];
