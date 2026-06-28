/**
 * @fileoverview Behaviour tests for the mcp-results-no-rerun architecture check
 * (ADR-0084): MCP tool handlers replay/read through their injected port and must
 * not import a run-command entry point to re-run the underlying tool.
 */
import { runCheckOnFixture, type FixtureFile } from '@opensip-cli/test-support';
import { describe, expect, it } from 'vitest';

import { analyzeMcpResultsNoRerun } from '../checks/architecture/mcp-results-no-rerun.js';
import { checks } from '../index.js';

const TOOL_PATH = 'packages/mcp/src/tools/get-latest-findings.ts';

function check() {
  const c = checks.find((x) => x.config.slug === 'mcp-results-no-rerun');
  if (!c) throw new Error('check not found: mcp-results-no-rerun');
  return c;
}

async function findingsFor(file: FixtureFile): Promise<number> {
  const run = await runCheckOnFixture(check(), { files: [file] });
  return run.findings.length;
}

describe('analyzeMcpResultsNoRerun (AST)', () => {
  it('flags an import of runGraph', () => {
    const v = analyzeMcpResultsNoRerun(
      "import { runGraph } from '@opensip-cli/graph/internal';\nexport const x = runGraph;",
      TOOL_PATH,
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('runGraph');
  });

  it('flags runFit/runSim/runYagni and a renamed import', () => {
    expect(
      analyzeMcpResultsNoRerun("import { runFit } from '@opensip-cli/fitness';", TOOL_PATH),
    ).toHaveLength(1);
    expect(
      analyzeMcpResultsNoRerun("import { runSim } from '@opensip-cli/simulation';", TOOL_PATH),
    ).toHaveLength(1);
    expect(
      analyzeMcpResultsNoRerun(
        "import { runYagni as build } from '@opensip-cli/yagni';",
        TOOL_PATH,
      ),
    ).toHaveLength(1);
  });

  it('does NOT flag a replay-only handler (no run-command import)', () => {
    const v = analyzeMcpResultsNoRerun(
      "import { jsonResult } from './tool-result.js';\nexport const x = jsonResult;",
      TOOL_PATH,
    );
    expect(v).toEqual([]);
  });

  it('does NOT flag a run-command symbol that appears only as text', () => {
    const v = analyzeMcpResultsNoRerun(
      "export const note = 'never call runGraph here';",
      TOOL_PATH,
    );
    expect(v).toEqual([]);
  });
});

describe('mcp-results-no-rerun (gate)', () => {
  it('flags a tool handler importing a run command', async () => {
    expect(
      await findingsFor({
        path: 'packages/mcp/src/tools/bad.ts',
        content: "import { runGraph } from '@opensip-cli/graph/internal';\nexport const x = runGraph;",
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag the same import OUTSIDE the guarded MCP paths (composition root)', async () => {
    expect(
      await findingsFor({
        path: 'packages/mcp/src/command.ts',
        content: "import { runGraph } from '@opensip-cli/graph/internal';\nexport const x = runGraph;",
      }),
    ).toBe(0);
  });
});
