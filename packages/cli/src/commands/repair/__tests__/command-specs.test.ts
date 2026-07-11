import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXIT_CODES, buildSignalEnvelope } from '@opensip-cli/contracts';
import {
  RunScope,
  ToolRegistry,
  runWithScope,
  type Signal,
  type SignalRepairAction,
  type Tool,
  type ToolSessionRecord,
} from '@opensip-cli/core';
import { DataStoreFactory } from '@opensip-cli/datastore';
import { SessionRepo } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionReplayRegistry } from '../../../session-replay-registry.js';
import { buildRepairGroupLeaves } from '../command-specs.js';

import type { CliCommandsContext } from '../../shared.js';
import type { CommandResult, StoredSession, UnitResult } from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';

let root: string;
let datastore: DataStore;
let exitCode: number | undefined;

function action(overrides: Partial<SignalRepairAction> = {}): SignalRepairAction {
  return {
    id: 'replace-ts-ignore',
    kind: 'text-replacement',
    title: 'Replace @ts-ignore',
    autofixable: true,
    target: {
      filePath: 'src/example.ts',
      line: 1,
      expectedText: '@ts-ignore',
      replacementText: '@ts-expect-error',
    },
    ...overrides,
  };
}

function signal(actions: readonly SignalRepairAction[] = [action()]): Signal {
  return {
    id: 'sig-1',
    source: 'typescript-directive-hygiene',
    provider: 'opensip',
    severity: 'medium',
    category: 'quality',
    ruleId: 'typescript-directive-hygiene',
    message: 'Use @ts-expect-error instead of @ts-ignore',
    filePath: 'src/example.ts',
    line: 1,
    fingerprint: 'fp-1',
    metadata: {},
    repair: { autofixable: actions.some((candidate) => candidate.autofixable), actions },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function unit(): UnitResult {
  return {
    slug: 'typescript-directive-hygiene',
    passed: false,
    violationCount: 1,
    durationMs: 1,
  };
}

function storedSession(id = 'sess-1'): StoredSession {
  return {
    id,
    tool: 'fit',
    cwd: root,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    score: 90,
    passed: false,
    durationMs: 1000,
    payload: { __version: 1 },
  };
}

function replayTool(actions: readonly SignalRepairAction[] = [action()]): Tool {
  return {
    identity: { name: 'fitness', aliases: ['fit'], layoutKey: 'fit' },
    metadata: { id: 'fit', name: 'fitness', version: '0.0.0', description: 'fitness' },
    commandSpecs: [],
    extensionPoints: {
      sessionReplay: {
        tool: 'fit',
        replaySession: (stored: ToolSessionRecord) => ({
          result: { type: 'text-lines', title: 'fit', lines: [] } satisfies CommandResult,
          fidelity: 'projection',
          envelope: buildSignalEnvelope({
            tool: 'fit',
            runId: stored.id,
            createdAt: '2026-01-01T00:00:00.000Z',
            units: [unit()],
            signals: [signal(actions)],
            policy: { failOnErrors: 1, failOnWarnings: 0 },
            runFaulted: false,
          }),
        }),
      },
    },
  };
}

function makeHarness(actions: readonly SignalRepairAction[] = [action()]): {
  readonly ctx: CliCommandsContext;
  readonly scope: RunScope;
} {
  const tools = new ToolRegistry();
  tools.register(replayTool(actions));
  const ctx: CliCommandsContext = {
    setExitCode: (code) => {
      exitCode = code;
    },
    render: () => Promise.resolve(),
    emitJson: () => undefined,
    emitRaw: () => undefined,
    emitError: () => undefined,
    pluginLayouts: [],
    toolScaffolds: [],
    sessionReplayRegistry: SessionReplayRegistry.fromTools(tools),
    datastore: () => datastore,
  };
  const scope = new RunScope({
    tools,
    projectContext: {
      projectRoot: root,
      configPath: join(root, 'opensip-cli.config.yml'),
      cwd: root,
      cwdExplicit: false,
      walkedUp: 0,
      scope: 'project',
    },
    datastore: () => datastore,
  });
  return { ctx, scope };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opensip-repair-command-'));
  datastore = DataStoreFactory.open({ backend: 'sqlite', path: join(root, 'd.sqlite') });
  exitCode = undefined;
});

afterEach(() => {
  datastore.close();
  rmSync(root, { recursive: true, force: true });
});

describe('repair command specs', () => {
  it('returns a configuration error when --signal is missing', async () => {
    const { ctx, scope } = makeHarness();
    const [preview] = buildRepairGroupLeaves(ctx);

    const result = await runWithScope(scope, async () =>
      preview.handler({ _args: ['latest'], tool: 'fit' }, ctx),
    );

    expect(exitCode).toBe(EXIT_CODES.CONFIGURATION_ERROR);
    expect(result).toMatchObject({
      type: 'error',
      code: 'missing-signal',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    });
  });

  it('replays the latest session and previews the selected repair action', async () => {
    new SessionRepo(datastore).save(storedSession());
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/example.ts'), '// @ts-ignore -- legacy\nlegacy();\n', {
      encoding: 'utf8',
      flag: 'w',
    });
    const { ctx, scope } = makeHarness();
    const [preview] = buildRepairGroupLeaves(ctx);

    const result = await runWithScope(scope, async () =>
      preview.handler({ _args: ['latest'], tool: 'fit', signal: 'fingerprint:fp-1' }, ctx),
    );

    expect(result).toMatchObject({
      type: 'repair-preview',
      status: 'previewed',
      session: { id: 'sess-1', tool: 'fitness', cwd: root },
      signal: { id: 'sig-1', fingerprint: 'fp-1' },
    });
    expect(exitCode).toBeUndefined();
  });

  it('sets a configuration exit for refused apply results', async () => {
    new SessionRepo(datastore).save(storedSession());
    const advisory = action({
      id: 'manual-action',
      kind: 'manual-text-edit',
      title: 'Manual action',
      autofixable: false,
    });
    const { ctx, scope } = makeHarness([advisory]);
    const [, apply] = buildRepairGroupLeaves(ctx);

    const result = await runWithScope(scope, async () =>
      apply.handler(
        {
          _args: ['latest'],
          tool: 'fit',
          signal: 'id:sig-1',
          action: 'manual-action',
          force: true,
        },
        ctx,
      ),
    );

    expect(result).toMatchObject({
      type: 'repair-apply',
      status: 'refused',
      refusal: { code: 'action-not-autofixable' },
    });
    expect(exitCode).toBe(EXIT_CODES.CONFIGURATION_ERROR);
  });
});
