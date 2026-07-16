import assert from 'node:assert/strict';
import test from 'node:test';

import { fingerprintStructuredResult } from '../perf/result-fingerprint.mjs';

test('result fingerprint ignores run timing, generated identities, paths, and result-set order', () => {
  const left = result('/workspace/left', ['alpha', 'beta']);
  const right = result('/workspace/right', ['beta', 'alpha']);
  right.envelope.runId = 'RUN_other';
  right.envelope.createdAt = '2026-07-14T00:01:00.000Z';
  right.envelope.units[0].durationMs = 999;
  right.envelope.signals[0].id = 'sig_other';
  right.envelope.signals[0].createdAt = '2026-07-14T00:02:00.000Z';

  assert.equal(
    fingerprintStructuredResult(left, { corpusRoot: '/workspace/left' }),
    fingerprintStructuredResult(right, { corpusRoot: '/workspace/right' }),
  );
});

test('result fingerprint retains semantic evidence differences', () => {
  const left = result('/workspace/left', ['alpha']);
  const right = result('/workspace/right', ['alpha']);
  right.envelope.units[0].violationCount = 1;

  assert.notEqual(
    fingerprintStructuredResult(left, { corpusRoot: '/workspace/left' }),
    fingerprintStructuredResult(right, { corpusRoot: '/workspace/right' }),
  );
});

test('result fingerprint retains repair action identities and ordered verification commands', () => {
  const baseline = result('/workspace/repo', ['alpha']);
  const changedAction = structuredClone(baseline);
  changedAction.envelope.signals[0].repair.actions[0].id = 'different-action';
  const changedCommandOrder = structuredClone(baseline);
  changedCommandOrder.envelope.signals[0].repair.actions[0].verification.commands.reverse();

  assert.notEqual(
    fingerprintStructuredResult(baseline, { corpusRoot: '/workspace/repo' }),
    fingerprintStructuredResult(changedAction, { corpusRoot: '/workspace/repo' }),
  );
  assert.notEqual(
    fingerprintStructuredResult(baseline, { corpusRoot: '/workspace/repo' }),
    fingerprintStructuredResult(changedCommandOrder, { corpusRoot: '/workspace/repo' }),
  );
});

function result(root, inputs) {
  return {
    kind: 'fit.run',
    status: 'ok',
    exitCode: 0,
    envelope: {
      runId: 'RUN_one',
      createdAt: '2026-07-14T00:00:00.000Z',
      declaredInputs: {
        cliVersion: '1.0.0',
        nodeVersion: process.version,
        platform: process.platform,
        tool: 'fit',
      },
      verdict: {
        passed: true,
        faulted: false,
        summary: { errors: 0, warnings: 0 },
      },
      units: inputs.map((input) => ({
        slug: input,
        passed: true,
        violationCount: 0,
        durationMs: 10,
      })),
      signals: inputs.map((input) => ({
        id: `sig_${input}_${root}`,
        createdAt: '2026-07-14T00:00:00.000Z',
        ruleId: input,
        filePath: `${root}/src/${input}.ts`,
        metadata: { semanticId: input, expectedDurationMs: 25 },
        repair: {
          actions: [
            {
              id: `repair-${input}`,
              kind: 'manual',
              title: `Repair ${input}`,
              autofixable: false,
              verification: {
                commands: ['pnpm typecheck', 'pnpm test'],
              },
            },
          ],
        },
      })),
    },
  };
}
