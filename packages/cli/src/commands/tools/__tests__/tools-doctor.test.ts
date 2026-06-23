import {
  BootstrapDiagnosticsCollector,
  CLI_DIAGNOSTIC_CODES,
  RunScope,
  runWithScope,
} from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { toolsDoctor } from '../doctor.js';

describe('toolsDoctor', () => {
  it('returns every buffered bootstrap diagnostic', () => {
    const collector = new BootstrapDiagnosticsCollector();
    collector.record({
      severity: 'warning',
      code: CLI_DIAGNOSTIC_CODES.OPENSIP_DISCOVERY_TOOL_TRUST_DENIED,
      category: 'discovery',
      message: 'Installed tool demo is not trusted to load.',
      impact: 'The package was skipped and its commands are not available.',
      provenance: { toolId: 'demo', packageName: '@demo/pkg' },
    });

    const scope = new RunScope({ bootstrapDiagnostics: collector.list() });
    const result = runWithScope(scope, () => toolsDoctor(scope.bootstrapDiagnostics.list()));

    expect(result).toEqual({
      type: 'tools-doctor',
      totalCount: 1,
      diagnostics: [
        expect.objectContaining({
          code: CLI_DIAGNOSTIC_CODES.OPENSIP_DISCOVERY_TOOL_TRUST_DENIED,
        }),
      ],
    });
  });

  it('returns an empty doctor result when no diagnostics were recorded', () => {
    const result = toolsDoctor([]);
    expect(result).toEqual({ type: 'tools-doctor', diagnostics: [], totalCount: 0 });
  });
});