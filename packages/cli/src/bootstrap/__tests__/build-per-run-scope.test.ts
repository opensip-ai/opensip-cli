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

// The contribution bag is intentionally typed as an arbitrary record: several
// tests pass non-standard / host-owned / dangerous scope keys (`alpha`,
// `logger`, `shared`, `constructor`, `dispose`) that are NOT part of
// `ScopeContribution` precisely to exercise the install guard's rejection paths.
function makeTool(name: string, contribution: Record<string, unknown>): Tool {
  return {
    identity: { name },
    metadata: {
      id: `00000000-0000-4000-8000-${name.padEnd(12, '0').slice(0, 12)}`,
      name,
      version: '0.0.0',
      description: `${name} fixture`,
    },
    commands: [{ name, description: `${name} command` }],
    extensionPoints: { contributeScope: () => contribution },
  };
}

function buildScopeWith(tools: readonly Tool[]) {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return buildPerRunScope({
    project,
    runId: 'RUN_test',
    cwd: project.cwd,
    parentCommand: 'fit',
    toolName: 'fitness',
    cliDefaults,
    registries: { languages: new LanguageRegistry(), tools: registry },
    manifests: [],
    provenance: [],
    logger,
    ui: { version: '0.0.0', update: undefined },
    datastoreAccess: 'local',
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

describe('buildPerRunScope datastoreAccess', () => {
  it('installs a denied ambient thunk for host-rpc-only and registers dispose', () => {
    const registry = new ToolRegistry();
    const scope = buildPerRunScope({
      project,
      runId: 'RUN_worker',
      cwd: project.cwd,
      parentCommand: '__tool-command-worker',
      toolName: 'external',
      cliDefaults,
      registries: { languages: new LanguageRegistry(), tools: registry },
      manifests: [],
      provenance: [],
      logger,
      ui: { version: '0.0.0', update: undefined },
      datastoreAccess: 'host-rpc-only',
    });
    expect(() => scope.datastore()).toThrow(PluginIncompatibleError);
    try {
      scope.datastore();
    } catch (error) {
      expect((error as PluginIncompatibleError).code).toBe('PLUGIN.WORKER.DATASTORE_DIRECT_ACCESS');
    }
    // Dispose must be safe (no open connection).
    expect(() => scope.dispose()).not.toThrow();
  });

  it('uses explicit local datastore access for ordinary host scopes', () => {
    const scope = buildScopeWith([]);
    // Local mode returns a thunk that may open SQLite; we only assert the
    // callable is present and is not the denied code path without invoking open
    // against a real project when possible. Calling dispose is always safe.
    expect(typeof scope.datastore).toBe('function');
    expect(() => scope.dispose()).not.toThrow();
  });
});
