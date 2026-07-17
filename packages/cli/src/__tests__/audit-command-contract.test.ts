import {
  LanguageRegistry,
  RunScope,
  ToolRegistry,
  runWithScope,
  type Tool,
} from '@opensip-cli/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeSuiteCommand = vi.hoisted(() => vi.fn());
const decideCurrentReportOpen = vi.hoisted(() => vi.fn(() => ({ shouldOpen: false })));
const planReportOpen = vi.hoisted(() =>
  vi.fn(() => ({ status: 'skipped', reason: 'not-requested' })),
);

vi.mock('../commands/suite/execute-suite-command.js', () => ({
  executeSuiteCommand,
}));
vi.mock('../bootstrap/report-open-policy.js', () => ({
  decideCurrentReportOpen,
  planReportOpen,
}));
vi.mock('../report-compose.js', () => ({ composeAndWriteReport: vi.fn() }));

import { rejectHostCommandCollisions } from '../bootstrap/reject-host-command-collisions.js';
import { buildAuditCommandSpec } from '../commands/audit-command-spec.js';
import { buildTopLevelHostSpecs } from '../commands/host-command-specs.js';
import { BUILT_IN_AUDIT_SUITE } from '../commands/suite/built-in-suites.js';
import { buildSuiteGroupLeaves } from '../commands/suite/suite-command-specs.js';
import { SUITE_RUN_OPTIONS } from '../commands/suite/suite-run-options.js';

import type { CliCommandsContext } from '../commands/shared.js';
import type { SuiteRunResult } from '@opensip-cli/contracts';

const RESULT: SuiteRunResult = {
  type: 'suite-run',
  suite: 'audit',
  suiteRunId: 'suite-curated',
  runId: 'run-curated',
  exitCode: 0,
  durationMs: 10,
  steps: [],
};

function collidingTool(): Tool {
  return {
    identity: { name: 'audit' },
    metadata: {
      id: '00000000-0000-4000-8000-000000000999',
      name: 'audit',
      version: '0.0.0-test',
      description: 'External fixture with a colliding display name',
    },
    commands: [{ name: 'audit', description: 'Colliding audit surface' }],
    commandSpecs: [
      {
        name: 'audit',
        description: 'Colliding audit surface',
        commonFlags: [],
        scope: 'project',
        output: 'command-result',
        handler: () =>
          Promise.resolve({ type: 'text-lines', title: 'collision', lines: ['unreachable'] }),
      },
    ],
  };
}

function aliasCollidingTool(): Tool {
  const tool = collidingTool();
  return {
    ...tool,
    identity: { name: 'other' },
    metadata: { ...tool.metadata, name: 'other' },
    commands: [{ name: 'other', description: 'Alias-colliding audit surface' }],
    commandSpecs: [
      {
        name: 'other',
        description: 'Alias-colliding audit surface',
        aliases: ['audit'],
        commonFlags: [],
        scope: 'project',
        output: 'command-result',
        handler: () =>
          Promise.resolve({ type: 'text-lines', title: 'collision', lines: ['unreachable'] }),
      },
    ],
  };
}

function makeCtx(tools: ToolRegistry): CliCommandsContext {
  return {
    setExitCode: vi.fn(),
    getExitCode: vi.fn(),
    render: vi.fn(() => Promise.resolve()),
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    emitError: vi.fn(),
    pluginLayouts: [],
    toolScaffolds: [],
    datastore: vi.fn(),
    tools,
    toolContext: {} as CliCommandsContext['toolContext'],
    toolRunActionHooks: {},
  };
}

describe('canonical audit command contract', () => {
  beforeEach(() => {
    executeSuiteCommand.mockReset();
    executeSuiteCommand.mockResolvedValue(RESULT);
    decideCurrentReportOpen.mockClear();
  });

  it('is mounted exactly once as a host-owned project command', () => {
    const ctx = makeCtx(new ToolRegistry());
    const auditSpecs = buildTopLevelHostSpecs(ctx).filter((spec) => spec.name === 'audit');

    expect(auditSpecs).toHaveLength(1);
    expect(auditSpecs[0]).toMatchObject({
      scope: 'project',
      output: 'raw-stream',
      rawStreamReason: 'runtime-render-dispatch',
      staticHandler: {
        package: 'opensip-cli',
        path: 'packages/cli/src/commands/audit-command-spec.ts',
        declaration: 'buildAuditCommandSpec',
      },
    });
  });

  it('shares suite scope descriptors without advertising unsupported delivery flags', () => {
    const ctx = makeCtx(new ToolRegistry());
    const auditSpec = buildAuditCommandSpec(ctx);
    const [suiteRunSpec] = buildSuiteGroupLeaves(ctx);

    expect(auditSpec.options).toEqual(SUITE_RUN_OPTIONS);
    expect(auditSpec.options).toEqual(suiteRunSpec.options);
    expect(auditSpec.commonFlags).toEqual(['cwd', 'json', 'quiet', 'verbose', 'debug', 'open']);
    expect(auditSpec.commonFlags).not.toContain('reportTo');
    expect(auditSpec.commonFlags).not.toContain('apiKey');
  });

  it('rejects a real Tool command collision before inventory and Commander mounting', () => {
    const tools = new ToolRegistry();
    tools.register(collidingTool());

    expect(rejectHostCommandCollisions(tools)).toEqual(['audit']);
    expect(tools.get('audit')).toBeUndefined();
    expect(
      buildTopLevelHostSpecs(makeCtx(tools)).filter((spec) => spec.name === 'audit'),
    ).toHaveLength(1);
  });

  it('rejects a Tool that claims the host command through a root alias', () => {
    const tools = new ToolRegistry();
    tools.register(aliasCollidingTool());

    expect(rejectHostCommandCollisions(tools)).toEqual(['other']);
    expect(tools.get('other')).toBeUndefined();
  });

  it('ignores configured-suite and tool-name collisions and returns the curated result', async () => {
    const tools = new ToolRegistry();
    const collision = collidingTool();
    tools.register(collision);
    const ctx = makeCtx(tools);
    const scope = new RunScope({ tools, languages: new LanguageRegistry() });
    const configuredAudit = {
      description: 'Configured replacement must remain suite-run-only',
      steps: [{ tool: collision.metadata.id, command: 'custom' }],
    };
    Object.assign(scope, {
      configDocument: { suites: { audit: configuredAudit } },
      projectContext: {
        projectRoot: '/repo',
        configPath: '/repo/opensip-cli.config.yml',
        scope: 'project',
      },
    });

    const returned = await runWithScope(scope, async () => {
      const result = await buildAuditCommandSpec(ctx).handler({ json: true }, ctx);
      return result;
    });

    expect(returned).toBe(RESULT);
    expect(executeSuiteCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'audit',
        resolved: { suite: BUILT_IN_AUDIT_SUITE, source: 'built-in' },
        tools: [collision],
        defaultChanged: true,
      }),
    );
    expect(executeSuiteCommand.mock.calls[0]?.[0].resolved.suite).not.toEqual(configuredAudit);
  });
});
