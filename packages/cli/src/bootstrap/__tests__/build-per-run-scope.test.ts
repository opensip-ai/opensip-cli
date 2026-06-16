/**
 * build-per-run-scope — focused coverage for the per-run scope contribution
 * contract. The pre-action hook remains the sequencer; this builder owns the
 * central invariant that tool subscopes may be installed but never overwrite
 * host-owned or previously contributed scope slots.
 */

import {
  LanguageRegistry,
  PluginIncompatibleError,
  ToolRegistry,
  type Logger,
  type ProjectContext,
  type ScopeContribution,
  type Tool,
} from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { buildPerRunScope } from '../build-per-run-scope.js';

import type { loadCliDefaults } from '../cli-defaults.js';

const project: ProjectContext = {
  cwd: process.cwd(),
  cwdExplicit: false,
  projectRoot: process.cwd(),
  configPath: undefined,
  walkedUp: 0,
  scope: 'none',
};

const cliDefaults = { cloud: {}, ui: {} } as ReturnType<typeof loadCliDefaults>;

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeTool(name: string, contribution: ScopeContribution): Tool {
  return {
    metadata: {
      id: `00000000-0000-4000-8000-${name.padEnd(12, '0').slice(0, 12)}`,
      name,
      version: '0.0.0',
      description: `${name} fixture`,
    },
    commands: [{ name, description: `${name} command` }],
    contributeScope: () => contribution,
  };
}

function buildScopeWith(tools: readonly Tool[]) {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return buildPerRunScope({
    project,
    runId: 'RUN_test',
    cwd: project.cwd,
    cliDefaults,
    registries: { languages: new LanguageRegistry(), tools: registry },
    manifests: [],
    provenance: [],
    logger,
    ui: { version: '0.0.0', update: undefined },
  });
}

describe('buildPerRunScope scope contributions', () => {
  it('installs disjoint tool subscopes', () => {
    const scope = buildScopeWith([
      makeTool('alpha', { alpha: { value: 1 } }),
      makeTool('beta', { beta: { value: 2 } }),
    ]);

    expect((scope as unknown as { alpha: { value: number } }).alpha.value).toBe(1);
    expect((scope as unknown as { beta: { value: number } }).beta.value).toBe(2);
  });

  it('rejects a contribution that overwrites a host-owned scope slot', () => {
    expect(() => buildScopeWith([makeTool('bad', { logger: {} })])).toThrow(
      PluginIncompatibleError,
    );
  });

  it('rejects duplicate tool contribution keys', () => {
    expect(() =>
      buildScopeWith([
        makeTool('first', { shared: { owner: 'first' } }),
        makeTool('second', { shared: { owner: 'second' } }),
      ]),
    ).toThrow(/overwrite scope key 'shared'/);
  });

  it('rejects dangerous contribution keys', () => {
    expect(() => buildScopeWith([makeTool('bad', { constructor: {} })])).toThrow(
      /forbidden scope key 'constructor'/,
    );
  });

  it('rejects a contribution that shadows a prototype method (dispose)', () => {
    expect(() => buildScopeWith([makeTool('bad', { dispose: { hijacked: true } })])).toThrow(
      /overwrite scope key 'dispose'/,
    );
  });
});
