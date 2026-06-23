import { liveRunTable, renderToText } from '@opensip-cli/cli-ui';
import { buildSignalEnvelope } from '@opensip-cli/contracts';
import {
  applyToolContributeScope,
  HOST_VERDICT_POLICY_FALLBACK,
  LanguageRegistry,
  RunScope,
  ToolRegistry,
  runWithScopeSync,
} from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { fitnessTool } from '../../../tool.js';
import { envelopeToFitRows } from '../envelope-view.js';

import type { LiveRunTableRow } from '@opensip-cli/cli-ui';

function fitRowsToLiveRunTable(rows: ReturnType<typeof envelopeToFitRows>): LiveRunTableRow[] {
  return rows.map((row) => ({
    unit: row.check,
    status: row.status,
    errors: row.errors,
    warnings: row.warnings,
    durationMs: row.durationMs,
    validated: row.validated,
    ignored: row.ignored,
    itemType: row.itemType,
  }));
}

function makeFitnessScope(): RunScope {
  const scope = new RunScope({ languages: new LanguageRegistry(), tools: new ToolRegistry() });
  applyToolContributeScope(scope, fitnessTool);
  return scope;
}

describe('envelopeToFitRows + liveRunTable', () => {
  it('renders the fitness seven-column verbose table from the envelope', () => {
    const envelope = buildSignalEnvelope({
      tool: 'fit',
      runId: 'run-fit',
      createdAt: '2026-06-04T00:00:00.000Z',
      units: [
        {
          slug: 'dead-code',
          passed: false,
          violationCount: 1,
          durationMs: 50,
          filesValidated: 4,
          itemType: 'files',
          ignoredCount: 1,
        },
        {
          slug: 'clean-check',
          passed: true,
          violationCount: 0,
          durationMs: 10,
          filesValidated: 2,
          itemType: 'files',
          ignoredCount: 0,
        },
      ],
      signals: [],
      policy: HOST_VERDICT_POLICY_FALLBACK,
      runFaulted: false,
    });

    const node = runWithScopeSync(makeFitnessScope(), () =>
      liveRunTable(fitRowsToLiveRunTable(envelopeToFitRows(envelope))),
    );
    expect(node).not.toBeNull();
    expect(renderToText(node!)).toMatchInlineSnapshot(`
      "Unit                                     | Status  | Errors | Warnings | Validated    | Ignores | Duration
      -----------------------------------------|---------|--------|----------|--------------|---------|-----------
      Dead Code                                | FAIL    | 0      | 0        | 4 files      | 1       | 50ms
      Clean Check                              | PASS    | 0      | 0        | 2 files      | 0       | 10ms"
    `);
  });
});
