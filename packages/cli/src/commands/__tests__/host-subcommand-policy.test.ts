import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveTrustPolicySources } from '@opensip-cli/config';
import { EXIT_CODES } from '@opensip-cli/contracts';
import { RunScope, runWithScope } from '@opensip-cli/core';
import { DataStoreFactory } from '@opensip-cli/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PolicyAuditCollector } from '../../bootstrap/policy-audit.js';
import { buildPolicyGroupLeaves } from '../host-subcommand-policy.js';

import type { CliCommandsContext } from '../shared.js';
import type { PolicyAuditEvent } from '@opensip-cli/config';
import type { DataStore } from '@opensip-cli/datastore';

const NOW = new Date('2026-07-02T00:00:00.000Z');

let root: string;
let datastore: DataStore;
let exitCode: number | undefined;

function makePolicy() {
  return resolveTrustPolicySources(
    [
      {
        tier: 'project',
        policy: {
          mode: 'strict',
          ci: 'strict',
          exceptions: [
            {
              id: 'temp-demo',
              subject: 'installed-tool:demo',
              action: 'load',
              reason: 'temporary rollout',
              expiresAt: '2026-09-01T00:00:00.000Z',
            },
          ],
        },
      },
    ],
    NOW,
  );
}

function event(overrides: Partial<PolicyAuditEvent> = {}): PolicyAuditEvent {
  return {
    occurredAt: '2026-07-02T00:00:00.000Z',
    action: 'load',
    subject: 'installed-tool:demo',
    outcome: 'allow',
    sourceTier: 'project',
    reasons: ['temporary rollout'],
    exceptionIds: ['temp-demo'],
    metadata: {},
    ...overrides,
  };
}

function makeContext(): CliCommandsContext {
  return {
    setExitCode: (code) => {
      exitCode = code;
    },
    render: () => Promise.resolve(),
    emitJson: () => undefined,
    emitRaw: () => undefined,
    emitError: () => undefined,
    pluginLayouts: [],
    toolScaffolds: [],
    datastore: () => datastore,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opensip-policy-command-'));
  datastore = DataStoreFactory.open({ backend: 'sqlite', path: join(root, 'd.sqlite') });
  exitCode = undefined;
});

afterEach(() => {
  datastore.close();
  rmSync(root, { recursive: true, force: true });
});

describe('policy command specs', () => {
  it('renders policy status from the current run scope', async () => {
    const audit = new PolicyAuditCollector('run-1');
    const scope = new RunScope({ trustPolicy: makePolicy(), policyAudit: audit });
    const [status] = buildPolicyGroupLeaves(makeContext());

    const result = await runWithScope(scope, () =>
      Promise.resolve(status.handler({}, makeContext())),
    );

    expect(result).toMatchObject({
      type: 'policy-status',
      mode: 'strict',
      ci: 'strict',
      orgStatus: { state: 'available' },
      sources: ['builtin', 'project'],
      exceptions: [{ id: 'temp-demo', sourceTier: 'project' }],
    });
    expect(exitCode).toBeUndefined();
  });

  it('explains invalid and denied policy decisions with command-result errors', async () => {
    const ctx = makeContext();
    const [, explain] = buildPolicyGroupLeaves(ctx);
    const scope = new RunScope({
      trustPolicy: makePolicy(),
      policyAudit: new PolicyAuditCollector(),
    });

    const invalidSubject = await runWithScope(scope, () =>
      Promise.resolve(explain.handler({ _args: ['bad-subject'], action: 'load' }, ctx)),
    );
    expect(invalidSubject).toMatchObject({
      type: 'error',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    });
    expect(exitCode).toBe(EXIT_CODES.CONFIGURATION_ERROR);

    exitCode = undefined;
    const invalidAction = await runWithScope(scope, () =>
      Promise.resolve(
        explain.handler({ _args: ['installed-tool:demo'], action: 'bad-action' }, ctx),
      ),
    );
    expect(invalidAction).toMatchObject({
      type: 'error',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    });
    expect(exitCode).toBe(EXIT_CODES.CONFIGURATION_ERROR);

    exitCode = undefined;
    const denied = await runWithScope(scope, () =>
      Promise.resolve(explain.handler({ _args: ['installed-tool:other'], action: 'load' }, ctx)),
    );
    expect(denied).toMatchObject({
      type: 'policy-explain',
      decision: { outcome: 'deny' },
    });
    expect(exitCode).toBeUndefined();
  });

  it('flushes, lists, limits, and exports policy audit events', async () => {
    const ctx = makeContext();
    const auditSpec = buildPolicyGroupLeaves(ctx)[2];
    const collector = new PolicyAuditCollector('run-1');
    collector.record(event());
    collector.record(event({ subject: 'installed-tool:other', outcome: 'deny', exceptionIds: [] }));
    const scope = new RunScope({
      trustPolicy: makePolicy(),
      policyAudit: collector,
      datastore: () => datastore,
    });
    const out = join(root, 'policy-audit.json');

    const limitOption = auditSpec.options?.find((option) => option.flag === '--limit');
    expect(limitOption?.parse?.('2', undefined)).toBe(2);
    expect(() => limitOption?.parse?.('0', undefined)).toThrow(/positive integer/);

    const result = await runWithScope(scope, () =>
      Promise.resolve(auditSpec.handler({ limit: 1, out }, ctx)),
    );

    expect(result).toMatchObject({
      type: 'policy-audit',
      totalCount: 1,
      exportedTo: out,
      events: [{ runId: 'run-1' }],
    });
    expect(readFileSync(out, 'utf8')).toContain('"type": "policy-audit"');
    expect(collector.list()).toEqual([]);
  });

  it.each(['1.5', '2events', '9007199254740992'])(
    'rejects non-integer policy audit limit %s',
    (raw) => {
      const auditSpec = buildPolicyGroupLeaves(makeContext())[2];
      const limitOption = auditSpec.options?.find((option) => option.flag === '--limit');

      expect(() => limitOption?.parse?.(raw, undefined)).toThrow(/positive integer/);
    },
  );
});
