/**
 * render-diagnostic — canonical human stderr format for CliDiagnostics (ADR-0060).
 */

import { CLI_DIAGNOSTIC_CODES, type CliDiagnostic } from '@opensip-cli/contracts';
import { describe, it, expect } from 'vitest';

import {
  renderDiagnosticHuman,
  renderDiagnosticsHuman,
  type DiagnosticRenderHost,
} from '../render-diagnostic.js';

const SAMPLE: CliDiagnostic = {
  severity: 'error',
  code: CLI_DIAGNOSTIC_CODES.OPENSIP_FIT_EMPTY_CHECK_REGISTRY,
  category: 'integrity',
  message: 'Fitness check registry is empty.',
  impact: 'No checks were loaded, so the run cannot produce credible findings.',
  action: 'Verify check packs are installed and reload the workspace injection.',
  logRef: 'run_abc123',
};

describe('renderDiagnosticHuman', () => {
  it('renders the canonical severity/code/message header plus impact and action', () => {
    const text = renderDiagnosticHuman(SAMPLE);

    expect(text).toContain('opensip: error [OPENSIP_FIT_EMPTY_CHECK_REGISTRY]: Fitness check registry is empty.');
    expect(text).toContain('impact: No checks were loaded');
    expect(text).toContain('action: Verify check packs');
    expect(text).toContain('log: run_abc123');
  });

  it('omits optional action and log lines when absent', () => {
    const minimal: CliDiagnostic = {
      severity: 'warning',
      code: CLI_DIAGNOSTIC_CODES.OPENSIP_DISCOVERY_TOOL_MANIFEST_INVALID,
      category: 'discovery',
      message: 'Skipping invalid tool manifest.',
      impact: 'The installed tool will not be available.',
    };

    const text = renderDiagnosticHuman(minimal);
    expect(text).toContain('opensip: warning [OPENSIP_DISCOVERY_TOOL_MANIFEST_INVALID]');
    expect(text).not.toContain('action:');
    expect(text).not.toContain('log:');
  });
});

describe('renderDiagnosticsHuman', () => {
  it('writes each diagnostic to stderr through the host seam only', () => {
    const lines: string[] = [];
    const host: DiagnosticRenderHost = {
      writeStderr: (text) => {
        lines.push(text);
      },
    };

    renderDiagnosticsHuman([SAMPLE], host);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`${renderDiagnosticHuman(SAMPLE)}\n`);
  });
});