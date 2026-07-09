import { describe, expect, it } from 'vitest';

import { isNoInitEligibleCommand, shouldRenderNoInitAdoptionHint } from '../no-init-eligibility.js';

import type { ProjectContext } from '@opensip-cli/core';

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
  it('recognizes only commands that can run from an ephemeral no-init config', () => {
    expect(isNoInitEligibleCommand('fitness')).toBe(true);
    expect(isNoInitEligibleCommand('fit')).toBe(true);
    expect(isNoInitEligibleCommand('graph')).toBe(true);
    expect(isNoInitEligibleCommand('graph impact')).toBe(true);
    expect(isNoInitEligibleCommand('suite run')).toBe(true);
    expect(isNoInitEligibleCommand('init')).toBe(false);
    expect(isNoInitEligibleCommand('tools list')).toBe(false);
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
