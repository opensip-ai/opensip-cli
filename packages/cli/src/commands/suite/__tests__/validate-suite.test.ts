import {
  ConfigurationError,
  defineCommand,
  RunScope,
  runWithScopeSync,
  type Tool,
  type ToolCliContext,
  type ToolProvenance,
} from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { validateSuite } from '../validate-suite.js';

const TOOL_ID = '00000000-0000-4000-8000-000000000001';

function parseCount(raw: string): number {
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new ConfigurationError(`count must be a number: ${raw}`);
  }
  return value;
}

function fixtureTool(): Tool {
  return {
    identity: { name: 'fitness' },
    metadata: {
      id: TOOL_ID,
      name: 'fitness',
      version: '0.0.0',
      description: 'fixture',
    },
    commands: [{ name: 'fit', description: 'fixture' }],
    commandSpecs: [
      defineCommand<unknown, ToolCliContext>({
        name: 'fit',
        description: 'fixture',
        commonFlags: ['cwd', 'json'],
        options: [
          { flag: '--recipe', value: '<name>', description: 'recipe' },
          { flag: '--gate-compare', description: 'compare', default: false },
          { flag: '--count', value: '<n>', description: 'count', parse: parseCount },
        ],
        scope: 'project',
        output: 'command-result',
        producesVerdict: true,
        handler: () => ({ type: 'help' }),
      }),
      defineCommand<unknown, ToolCliContext>({
        name: 'live',
        description: 'fixture',
        commonFlags: [],
        scope: 'project',
        output: 'live-view',
        handler: () => undefined,
      }),
      // A non-verdict info command: valid command, but not a gate step.
      defineCommand<unknown, ToolCliContext>({
        name: 'list',
        description: 'fixture',
        commonFlags: ['cwd', 'json'],
        scope: 'project',
        output: 'command-result',
        handler: () => ({ type: 'help' }),
      }),
      defineCommand<unknown, ToolCliContext>({
        name: 'context',
        description: 'fixture evidence',
        commonFlags: [],
        scope: 'project',
        output: 'raw-stream',
        rawStreamReason: 'host-orchestrated-evidence',
        producesEvidenceSnapshot: true,
        handler: () => undefined,
      }),
      defineCommand<unknown, ToolCliContext>({
        name: 'dual',
        description: 'invalid combined fixture',
        commonFlags: [],
        scope: 'project',
        output: 'command-result',
        producesVerdict: true,
        producesEvidenceSnapshot: true,
        handler: () => undefined,
      }),
    ],
  };
}

describe('validateSuite', () => {
  it('resolves tool UUID and command args', () => {
    const suite = validateSuite({
      name: 'security',
      tools: [fixtureTool()],
      suite: {
        steps: [
          {
            tool: TOOL_ID,
            command: 'fit',
            args: { recipe: 'security', gateCompare: true },
          },
        ],
      },
    });

    expect(suite.steps[0]?.tool.metadata.name).toBe('fitness');
    expect(suite.steps[0]?.args).toEqual({ recipe: 'security', gateCompare: true });
  });

  it('rejects unknown tool UUIDs', () => {
    expect(() =>
      validateSuite({
        name: 'bad',
        tools: [fixtureTool()],
        suite: {
          steps: [{ tool: '00000000-0000-4000-8000-00000000ffff', command: 'fit' }],
        },
      }),
    ).toThrow(/unknown tool UUID/);
  });

  it('rejects unknown commands and live-view commands', () => {
    expect(() =>
      validateSuite({
        name: 'bad',
        tools: [fixtureTool()],
        suite: { steps: [{ tool: TOOL_ID, command: 'missing' }] },
      }),
    ).toThrow(/unknown command/);
    expect(() =>
      validateSuite({
        name: 'bad',
        tools: [fixtureTool()],
        suite: { steps: [{ tool: TOOL_ID, command: 'live' }] },
      }),
    ).toThrow(/live-view command/);
  });

  it('rejects a non-verdict command as a suite step', () => {
    // A valid, resolvable command that simply is not a gate step. validateSuite
    // aggregates per-step failures into one CLI.SUITE.INVALID error (the
    // per-step NOT_A_RUN_COMMAND code is folded into the message, like live-view).
    expect(() =>
      validateSuite({
        name: 'bad',
        tools: [fixtureTool()],
        suite: { steps: [{ tool: TOOL_ID, command: 'list' }] },
      }),
    ).toThrow(/does not produce a gate verdict[\s\S]*verdict or an evidence snapshot/);
  });

  it('admits evidence-only commands and rejects combined v1 markers', () => {
    const validated = validateSuite({
      name: 'context',
      tools: [fixtureTool()],
      suite: { steps: [{ tool: TOOL_ID, command: 'context' }] },
    });
    expect(validated.steps[0]?.kind).toBe('evidence');
    expect(() =>
      validateSuite({
        name: 'bad',
        tools: [fixtureTool()],
        suite: { steps: [{ tool: TOOL_ID, command: 'dual' }] },
      }),
    ).toThrow(/declares both verdict and evidence snapshot capabilities/);
  });

  it('rejects evidence producers selected for external-worker dispatch', () => {
    const provenance: ToolProvenance = {
      source: 'installed',
      id: 'fitness',
      stableId: TOOL_ID,
      version: '0.0.0',
      manifestHash: 'fixture-hash',
    };
    const scope = new RunScope({ toolProvenance: [provenance] });

    expect(() =>
      runWithScopeSync(scope, () =>
        validateSuite({
          name: 'external-context',
          tools: [fixtureTool()],
          suite: { steps: [{ tool: TOOL_ID, command: 'context' }] },
        }),
      ),
    ).toThrow(/external worker transport.*does not carry evidence snapshots/u);
  });

  it('rejects run-scope flags, reserved deferred fields, unknown args, and parser failures', () => {
    expect(() =>
      validateSuite({
        name: 'bad',
        tools: [fixtureTool()],
        suite: { steps: [{ tool: TOOL_ID, command: 'fit', args: { cwd: 'src' } }] },
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      validateSuite({
        name: 'bad',
        tools: [fixtureTool()],
        suite: { steps: [{ tool: TOOL_ID, command: 'fit', args: { nope: true } }] },
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      validateSuite({
        name: 'bad',
        tools: [fixtureTool()],
        suite: { steps: [{ tool: TOOL_ID, command: 'fit', args: { count: 'NaN' } }] },
      }),
    ).toThrow(/count must be a number/);
    expect(() =>
      validateSuite({
        name: 'bad',
        tools: [fixtureTool()],
        suite: {
          execution: { mode: 'parallel' },
          steps: [{ tool: TOOL_ID, command: 'fit', cwd: 'src' }],
        },
      }),
    ).toThrow(/reserved execution options[\s\S]*reserved per-step cwd/);
  });

  it('accumulates multiple load-time errors before throwing', () => {
    expect(() =>
      validateSuite({
        name: 'bad',
        tools: [fixtureTool()],
        suite: {
          steps: [
            { tool: TOOL_ID, command: 'fit', args: { cwd: 'src' } },
            { tool: TOOL_ID, command: 'missing', args: { nope: true } },
          ],
        },
      }),
    ).toThrow(/run-scope arg 'cwd'[\s\S]*unknown command 'missing'/);
  });
});
