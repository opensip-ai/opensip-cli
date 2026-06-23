/**
 * Correlation assembly at the bootstrap composition root (subprocess-correlation
 * telemetry spec, Phase 0 Tasks 0.4–0.5). Covers the two success criteria:
 *
 *   - B2: `RunScope.correlation` is assembled here from the resolved cloud config
 *     — `repo` present when cloud egress is active, absent (not an empty sentinel)
 *     when it is off; `tool`/`parentCommand` come from the inputs.
 *   - GAP e: `parentCommand` is the FIRST segment of the invoked command path
 *     (`graph`), never a child's own `graph-shard-worker`.
 *   - ADR-0004: `traceId` is present only when OTel is on (undefined here, no SDK).
 *
 * `buildPerRunScope` is exercised directly with the cloud resolvers stubbed so the
 * cloud-active gate is deterministic (no dependence on the test machine's
 * `~/.opensip-cli` cloud config). `executePostBailoutBootstrap` is driven with an
 * injected `buildPerRunScope` to capture the derived `parentCommand` (GAP e).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import * as configModule from '@opensip-cli/config';
import {
  defineCommand,
  LanguageRegistry,
  ToolRegistry,
  type Logger,
  type ProjectContext,
  type RunScope,
} from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildCommandScopeIndex } from '../../commands/command-scope-index.js';
import { buildPerRunScope, type BuildPerRunScopeInput } from '../build-per-run-scope.js';
import {
  executePostBailoutBootstrap,
  type PostBailoutBootstrapDeps,
} from '../execute-post-bailout-bootstrap.js';
import { planPreActionBootstrap } from '../plan-pre-action-bootstrap.js';

import type { loadCliDefaults } from '../cli-defaults.js';
import type { PreActionRuntime } from '../pre-action-runtime.js';

/**
 * A minimal entered-scope stand-in for the GAP-e capture deps: only the members
 * `executePostBailoutBootstrap` touches AFTER `buildPerRunScope` returns
 * (`diagnostics.event`/`.counter`, `configDocument`, `dispose`). The real scope
 * assembly is exercised separately in the B2 suite above; here we only need to
 * observe the `parentCommand` the bootstrap derives.
 */
function stubEnteredScope(): RunScope {
  return {
    diagnostics: { event: () => undefined, counter: () => undefined },
    configDocument: undefined,
    dispose: () => undefined,
  } as unknown as RunScope;
}

/**
 * Inject deps that capture the `BuildPerRunScopeInput` the bootstrap passes to
 * `buildPerRunScope` and stub out every other side-effecting seam so no real
 * scope is built/entered. `isScopeEntered` returns true so the NOT_ENTERED guard
 * passes against the stub.
 */
function captureDeps(onBuild: (input: BuildPerRunScopeInput) => void): PostBailoutBootstrapDeps {
  return {
    buildPerRunScope: (input) => {
      onBuild(input);
      return stubEnteredScope();
    },
    enterScope: () => undefined,
    isScopeEntered: () => true,
    startProfiling: () => undefined,
    maybeInitializeOwningTool: () => Promise.resolve(),
    loadOwningToolCapabilities: () => Promise.resolve(0),
    checkForUpdate: () => undefined,
  };
}

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const cliDefaults = { cloud: {}, ui: {} } as ReturnType<typeof loadCliDefaults>;

function projectAt(root: string, scope: 'project' | 'none'): ProjectContext {
  return {
    cwd: root,
    cwdExplicit: false,
    projectRoot: root,
    configPath: scope === 'project' ? join(root, 'opensip-cli.config.yml') : undefined,
    walkedUp: 0,
    scope,
  };
}

function baseInput(
  project: ProjectContext,
  overrides: Partial<BuildPerRunScopeInput> = {},
): BuildPerRunScopeInput {
  return {
    project,
    runId: 'RUN_parent',
    cwd: project.cwd,
    parentCommand: 'graph',
    toolName: 'graph',
    cliDefaults,
    registries: { languages: new LanguageRegistry(), tools: new ToolRegistry() },
    manifests: [],
    provenance: [],
    logger,
    ui: { version: '0.0.0', update: undefined },
    ...overrides,
  };
}

/** A bare runtime with empty registries (the GAP-e capture tests). */
function emptyRuntime(): PreActionRuntime {
  return {
    languages: new LanguageRegistry(),
    tools: new ToolRegistry(),
    manifests: [],
    provenance: [],
    bootstrapDiagnostics: [],
  };
}

describe('buildPerRunScope correlation assembly (B2)', () => {
  beforeEach(() => {
    // Default both resolvers to the cloud-OFF state; each test opts into
    // cloud-active by re-stubbing resolveApiKey.
    vi.spyOn(configModule, 'resolveEffectiveCloudConfig').mockReturnValue(undefined);
    vi.spyOn(configModule, 'resolveApiKey').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attaches repo and stamps tool/parentCommand when cloud egress is ACTIVE', () => {
    vi.spyOn(configModule, 'resolveApiKey').mockReturnValue('a-key');
    vi.spyOn(configModule, 'resolveEffectiveCloudConfig').mockReturnValue({ sync: true });

    const root = mkdtempSync(join(tmpdir(), 'corr-active-'));
    try {
      const scope = buildPerRunScope(baseInput(projectAt(root, 'project')));
      const c = scope.correlation;
      expect(c).toBeDefined();
      expect(c?.runId).toBe('RUN_parent');
      expect(c?.tool).toBe('graph');
      expect(c?.parentCommand).toBe('graph');
      // repo is the project-root basename (the cwd-derived floor, Assumption 2),
      // present because cloud is active.
      expect(c?.repo).toBe(basename(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('omits repo/repoId/tenantId (no empty sentinel) when cloud egress is OFF (no key)', () => {
    const root = mkdtempSync(join(tmpdir(), 'corr-off-'));
    try {
      const scope = buildPerRunScope(baseInput(projectAt(root, 'project')));
      const c = scope.correlation;
      expect(c).toBeDefined();
      expect(c).not.toHaveProperty('repo');
      expect(c).not.toHaveProperty('repoId');
      expect(c).not.toHaveProperty('tenantId');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('omits repo when --no-cloud is set even though a key resolves', () => {
    vi.spyOn(configModule, 'resolveApiKey').mockReturnValue('a-key');
    vi.spyOn(configModule, 'resolveEffectiveCloudConfig').mockReturnValue({ sync: true });

    const root = mkdtempSync(join(tmpdir(), 'corr-nocloud-'));
    try {
      const scope = buildPerRunScope(
        baseInput(projectAt(root, 'project'), { noCloud: true, apiKey: 'a-key' }),
      );
      expect(scope.correlation).not.toHaveProperty('repo');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('traceId is undefined when OTel is off (no SDK in the test process)', () => {
    const root = mkdtempSync(join(tmpdir(), 'corr-trace-'));
    try {
      const scope = buildPerRunScope(baseInput(projectAt(root, 'project')));
      expect(scope.correlation).not.toHaveProperty('traceId');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('parentCommand is the FIRST segment of the command path (GAP e)', () => {
  const COMMAND_SCOPES = buildCommandScopeIndex({
    hostSpecs: [],
    hostGroups: [],
    toolSpecs: [],
  });

  it('derives parentCommand=graph from a `graph` invocation (never graph-shard-worker)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'corr-gape-'));
    writeFileSync(join(tmp, 'opensip-cli.config.yml'), 'schemaVersion: 1\ntargets: {}\n', 'utf8');
    try {
      const plan = planPreActionBootstrap({
        opts: {},
        cwd: tmp,
        cwdExplicit: false,
        runId: 'RUN_parent',
        commandName: 'graph',
        commandPath: 'graph',
        commandScopes: COMMAND_SCOPES,
      });

      let captured: BuildPerRunScopeInput | undefined;
      await executePostBailoutBootstrap(
        { plan, runtime: emptyRuntime(), version: '0.0.0', noCloud: true },
        captureDeps((input) => {
          captured = input;
        }),
      );

      expect(captured?.parentCommand).toBe('graph');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('takes the FIRST segment of a grouped command path (e.g. `tools list` → tools)', async () => {
    const scopes = buildCommandScopeIndex({
      hostSpecs: [],
      hostGroups: [
        {
          name: 'tools',
          description: 'tools',
          leaves: [
            defineCommand({
              name: 'list',
              description: 'list',
              commonFlags: [],
              scope: 'none',
              output: 'command-result',
              handler: () => undefined,
            }),
          ],
        },
      ],
      toolSpecs: [],
    });
    const tmp = mkdtempSync(join(tmpdir(), 'corr-grouped-'));
    try {
      const plan = planPreActionBootstrap({
        opts: {},
        cwd: tmp,
        cwdExplicit: false,
        runId: 'RUN_parent',
        commandName: 'list',
        commandPath: 'tools list',
        commandScopes: scopes,
      });

      let captured: BuildPerRunScopeInput | undefined;
      await executePostBailoutBootstrap(
        { plan, runtime: emptyRuntime(), version: '0.0.0', noCloud: true },
        captureDeps((input) => {
          captured = input;
        }),
      );

      expect(captured?.parentCommand).toBe('tools');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
