/**
 * @fileoverview mcp-first-agent-guidance — OpenSIP agent guidance and MCP result
 * descriptors must steer existing-result questions to MCP persisted replay
 * before raw logs, direct SQLite, or reruns.
 *
 * ADR-0109 records the decision. This project-local check is intentionally
 * opensip-cli specific: it scans this repo's init guidance template and MCP
 * result-tool descriptors so the dogfood gate catches drift in the adoption
 * surface agents read first.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { defineCheck } from '@opensip-cli/fitness';

export const MCP_FIRST_GUIDANCE_TARGETS = [
  'packages/cli/src/commands/init/agent-guidance.ts',
  'packages/mcp/src/tools/list-runs.ts',
  'packages/mcp/src/tools/show-run.ts',
  'packages/mcp/src/tools/get-latest-findings.ts',
  'packages/mcp/src/tools/get-agent-catalog.ts',
];

const REQUIRED = [
  {
    key: 'mcp-first',
    test: (content) =>
      /\bMCP\b/i.test(content) &&
      /(?:first|before re-running|before re-run|source precedence|result tools)/i.test(content),
    message: 'must tell agents to use OpenSIP MCP/result tools first for existing results',
  },
  {
    key: 'runtime-logs',
    test: (content) => content.includes('.runtime/logs'),
    message: 'must explicitly forbid grepping .runtime/logs for result/history questions',
  },
  {
    key: 'datastore-sqlite',
    test: (content) => content.includes('datastore.sqlite'),
    message:
      'must explicitly forbid reading datastore.sqlite directly for result/history questions',
  },
  {
    key: 'no-rerun',
    test: (content) => /re-?runs?|re-running|rerun/i.test(content),
    message: 'must explicitly steer stored-result questions away from unnecessary reruns',
  },
];

export function analyzeMcpFirstAgentGuidance(files) {
  const violations = [];
  for (const file of files) {
    for (const req of REQUIRED) {
      if (req.test(file.content)) continue;
      violations.push({
        filePath: file.path,
        line: 1,
        severity: 'error',
        message: `MCP-first agent guidance drift: ${req.message}.`,
        suggestion:
          'Keep the generated guidance / MCP descriptor explicit: use MCP result tools first, and do not use .runtime/logs, datastore.sqlite, or a fresh rerun for stored-result questions.',
      });
    }
  }
  return violations;
}

export function analyzeMcpFirstAgentGuidanceProject(root) {
  const files = [];
  const missing = [];
  for (const rel of MCP_FIRST_GUIDANCE_TARGETS) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) {
      missing.push(abs);
      continue;
    }
    files.push({ path: abs, content: readFileSync(abs, 'utf8') });
  }

  return [
    ...missing.map((filePath) => ({
      filePath,
      line: 1,
      severity: 'error',
      message: 'MCP-first guidance source is missing from this repo.',
      suggestion: 'Restore the source or update mcp-first-agent-guidance.mjs target paths.',
    })),
    ...analyzeMcpFirstAgentGuidance(files),
  ];
}

export const checks = [
  defineCheck({
    id: '83f94169-3270-48cb-8239-2ff396214dc0',
    slug: 'mcp-first-agent-guidance',
    description:
      'Agent guidance and MCP result descriptors must route existing results to MCP first',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'documentation'],
    contentFilter: 'raw',
    async analyzeAll() {
      return analyzeMcpFirstAgentGuidanceProject(process.cwd());
    },
  }),
];
