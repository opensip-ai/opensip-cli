import { defineCommand } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { buildCommandScopeIndex } from '../../commands/command-scope-index.js';
import { isNoInitEligibleCommand, shouldRenderNoInitAdoptionHint } from '../no-init-eligibility.js';

import type { CliCommandsContext } from '../../commands/shared.js';
import type { ProjectContext } from '@opensip-cli/core';

/**
 * Eligibility is DERIVED from `CommandSpec.noInit` (see
 * `__tests__/no-init-surface.test.ts` for the drift guard against the real
 * mounted specs). These fixtures only pin the lookup itself.
 */
function spec(name: string, noInit: boolean) {
  return defineCommand<unknown, CliCommandsContext>({
    name,
    description: `${name} command`,
    commonFlags: [],
    scope: 'project',
    ...(noInit ? { noInit: true } : {}),
    output: 'command-result',
    handler: () => undefined,
  });
}

const INDEX = buildCommandScopeIndex({
  toolSpecs: [spec('fitness', true), spec('graph', true)],
  hostSpecs: [spec('audit', true), spec('init', false)],
  hostGroups: [
    { name: 'suite', description: 'suite', leaves: [spec('run', true)] },
    { name: 'tools', description: 'tools', leaves: [spec('list', false)] },
  ],
});

function project(scope: ProjectContext['scope']): ProjectContext {
  return {
    cwd: '/repo',
    cwdExplicit: false,
    projectRoot: '/repo',
    configPath: scope === 'project' ? '/repo/opensip-cli.config.yml' : undefined,
    walkedUp: 0,
    scope,
  };
}

describe('no-init eligibility branches', () => {
  it('recognizes only commands whose spec declares noInit', () => {
    expect(isNoInitEligibleCommand('audit', INDEX)).toBe(true);
    expect(isNoInitEligibleCommand('suite run', INDEX)).toBe(true);
    expect(isNoInitEligibleCommand('fitness', INDEX)).toBe(true);
    expect(isNoInitEligibleCommand('graph', INDEX)).toBe(true);
    expect(isNoInitEligibleCommand('init', INDEX)).toBe(false);
    expect(isNoInitEligibleCommand('tools list', INDEX)).toBe(false);
    expect(isNoInitEligibleCommand('unknown-command', INDEX)).toBe(false);
  });

  it('renders the adoption hint only for human ephemeral runs', () => {
    expect(shouldRenderNoInitAdoptionHint({ project: project('ephemeral'), opts: {} })).toBe(true);
    expect(
      shouldRenderNoInitAdoptionHint({
        project: project('ephemeral'),
        opts: { sarif: '' },
      }),
    ).toBe(true);
    expect(
      shouldRenderNoInitAdoptionHint({
        project: project('project'),
        opts: {},
      }),
    ).toBe(false);
    expect(
      shouldRenderNoInitAdoptionHint({
        project: project('ephemeral'),
        opts: { json: true },
      }),
    ).toBe(false);
    expect(
      shouldRenderNoInitAdoptionHint({
        project: project('ephemeral'),
        opts: { help: true },
      }),
    ).toBe(false);
    expect(
      shouldRenderNoInitAdoptionHint({
        project: project('ephemeral'),
        opts: { sarif: 'out.sarif' },
      }),
    ).toBe(false);
  });
});
