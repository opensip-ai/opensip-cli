import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigurationError } from '@opensip-cli/core';
import { afterAll, describe, expect, it } from 'vitest';

import { graphCommandSpec } from '../graph/graph-command-spec.js';
import { planGraphExecution, validateGraphCommandFlags } from '../graph-command-plan.js';

import type { GraphCommandOptions } from '../graph-options.js';

const tmpProject = mkdtempSync(join(tmpdir(), 'graph-plan-'));
mkdirSync(join(tmpProject, 'src'), { recursive: true });
mkdirSync(join(tmpProject, 'lib'), { recursive: true });

function baseOpts(over: Partial<GraphCommandOptions> = {}): GraphCommandOptions {
  return {
    cwd: tmpProject,
    ...over,
  };
}

describe('validateGraphCommandFlags', () => {
  it('rejects gate-save and gate-compare together', () => {
    expect(() =>
      validateGraphCommandFlags(baseOpts({ gateSave: true, gateCompare: true })),
    ).toThrow(ConfigurationError);
  });

  it('rejects workspace with positional paths', () => {
    expect(() => validateGraphCommandFlags(baseOpts({ workspace: true, paths: ['src'] }))).toThrow(
      ConfigurationError,
    );
  });

  it('rejects workspace with gate flags', () => {
    expect(() => validateGraphCommandFlags(baseOpts({ workspace: true, gateSave: true }))).toThrow(
      ConfigurationError,
    );
  });
});

describe('planGraphExecution', () => {
  it('selects workspace shape', () => {
    const plan = planGraphExecution(baseOpts({ workspace: true }));
    expect(plan.shape).toBe('workspace');
    expect(plan.positionalPaths).toEqual([]);
  });

  it('selects multi-path when more than one positional path resolves', () => {
    const plan = planGraphExecution(baseOpts({ paths: ['src', 'lib'] }));
    expect(plan.shape).toBe('multi-path');
    expect(plan.positionalPaths.length).toBe(2);
  });

  it('selects single-path for zero or one positional path', () => {
    expect(planGraphExecution(baseOpts()).shape).toBe('single-path');
    expect(planGraphExecution(baseOpts({ paths: ['src'] })).shape).toBe('single-path');
  });
});

describe('graphCommandSpec option parsers', () => {
  it('parses positive concurrency and rejects invalid values', () => {
    const concurrency = (graphCommandSpec.options ?? []).find(
      (option) => option.flag === '--concurrency',
    );
    expect(concurrency?.parse?.('3', undefined)).toBe(3);
    expect(() => concurrency?.parse?.('0', undefined)).toThrow(/positive integer/);
    expect(() => concurrency?.parse?.('abc', undefined)).toThrow(/positive integer/);
  });
});

afterAll(() => {
  rmSync(tmpProject, { recursive: true, force: true });
});
