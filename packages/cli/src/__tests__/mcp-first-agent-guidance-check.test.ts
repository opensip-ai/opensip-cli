import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MCP_FIRST_GUIDANCE_TARGETS,
  analyzeMcpFirstAgentGuidance,
  analyzeMcpFirstAgentGuidanceProject,
} from '../../../../opensip-cli/fit/checks/mcp-first-agent-guidance.mjs';

const GOOD =
  'Use OpenSIP MCP result tools first before re-running existing results. Do not grep .runtime/logs or read datastore.sqlite directly; never re-runs fit.';

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('mcp-first-agent-guidance local check', () => {
  it('accepts source text with MCP-first and anti-pattern guidance', () => {
    expect(analyzeMcpFirstAgentGuidance([{ path: '/repo/a.ts', content: GOOD }])).toEqual([]);
  });

  it('flags missing anti-pattern text', () => {
    const findings = analyzeMcpFirstAgentGuidance([
      {
        path: '/repo/a.ts',
        content: 'Use OpenSIP MCP result tools first before re-running existing results.',
      },
    ]);
    expect(findings.some((finding) => finding.message.includes('.runtime/logs'))).toBe(true);
    expect(findings.some((finding) => finding.message.includes('datastore.sqlite'))).toBe(true);
  });

  it('flags missing MCP-positive routing language', () => {
    const findings = analyzeMcpFirstAgentGuidance([
      {
        path: '/repo/a.ts',
        content: 'Do not grep .runtime/logs or read datastore.sqlite directly; avoid reruns.',
      },
    ]);
    expect(findings.some((finding) => finding.message.includes('MCP/result tools first'))).toBe(
      true,
    );
  });

  it('fails closed when every tracked source file is missing', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'opensip-mcp-first-guidance-'));
    const findings = analyzeMcpFirstAgentGuidanceProject(tempDir);
    expect(findings).toHaveLength(MCP_FIRST_GUIDANCE_TARGETS.length);
    expect(findings.every((finding) => finding.message.includes('source is missing'))).toBe(true);
  });
});
