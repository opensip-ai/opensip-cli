import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAllOrRollback, applyAndVerifyRepair, applyRepair } from '../apply.js';
import { previewRepair } from '../planner.js';

import type { RepairBuildInput } from '../types.js';
import type { ProcessRunner } from '../verify-runner.js';
import type { RepairVerificationResult } from '@opensip-cli/contracts';
import type { Signal, SignalRepairAction } from '@opensip-cli/core';

function writeFixture(root: string, relativePath: string, content: string): void {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
}

function action(overrides: Partial<SignalRepairAction>): SignalRepairAction {
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

function signal(actions: readonly SignalRepairAction[]): Signal {
  return {
    id: 'sig-1',
    source: 'typescript-directive-hygiene',
    provider: 'opensip',
    severity: 'medium',
    category: 'quality',
    ruleId: 'fit:typescript-directive-hygiene',
    message: 'Use @ts-expect-error instead of @ts-ignore',
    filePath: 'src/example.ts',
    line: 1,
    metadata: {},
    repair: { autofixable: actions.some((candidate) => candidate.autofixable), actions },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function input(root: string, actions: readonly SignalRepairAction[]): RepairBuildInput {
  return {
    projectRoot: root,
    session: { id: 'sess_1', tool: 'fit', cwd: root },
    signals: [signal(actions)],
    selector: 'index:0',
  };
}

const SUCCESS_RUNNER: ProcessRunner = () =>
  Promise.resolve({
    exitCode: 0,
    stdout: '{}',
    stderr: '',
    durationMs: 1,
    timedOut: false,
    truncated: false,
  });

describe('repair planner', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opensip-repair-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('previews a text replacement without modifying the file', () => {
    writeFixture(root, 'src/example.ts', '// @ts-ignore -- legacy third-party type\nlegacy();\n');

    const result = previewRepair(input(root, [action({})]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('previewed');
    expect(result.value.changes[0]?.diff).toContain('-// @ts-ignore');
    expect(result.value.changes[0]?.diff).toContain('+// @ts-expect-error');
    expect(readFileSync(join(root, 'src/example.ts'), 'utf8')).toContain('@ts-ignore');
  });

  it('applies a text replacement when forced in a non-git fixture', () => {
    writeFixture(root, 'src/example.ts', '// @ts-ignore -- legacy third-party type\nlegacy();\n');

    const result = applyRepair({
      ...input(root, [action({})]),
      actionId: 'replace-ts-ignore',
      force: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('applied');
    expect(readFileSync(join(root, 'src/example.ts'), 'utf8')).toContain('@ts-expect-error');
  });

  it('M8: rolls back earlier files when a later write fails mid-batch', () => {
    const aPath = join(root, 'a.ts');
    const bPath = join(root, 'b-dir');
    writeFileSync(aPath, 'before-a\n', 'utf8');
    // Second target is a directory so writeFileSync throws after a.ts is committed.
    mkdirSync(bPath, { recursive: true });

    const result = applyAllOrRollback([
      { absolutePath: aPath, before: 'before-a\n', after: 'after-a\n' },
      { absolutePath: bPath, before: 'before-b\n', after: 'after-b\n' },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('apply-failed');
      expect(result.error.message).toMatch(/mid-batch/);
    }
    // a.ts must be restored to its before content — no partial multi-file apply.
    expect(readFileSync(aPath, 'utf8')).toBe('before-a\n');
  });

  it('uses signal file fallback and preserves CRLF text replacement newlines', () => {
    writeFixture(root, 'src/example.ts', '// @ts-ignore\r\nlegacy();\r\n');
    const result = applyRepair({
      ...input(root, [
        action({
          target: {
            line: 1,
            expectedText: '@ts-ignore',
            replacementText: '@ts-expect-error',
          },
        }),
      ]),
      actionId: 'replace-ts-ignore',
      force: true,
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, 'src/example.ts'), 'utf8')).toBe(
      '// @ts-expect-error\r\nlegacy();\r\n',
    );
  });

  it('uses logical line numbers without normalizing mixed line endings', () => {
    const before = '// first\n// @ts-ignore\r\nlegacy();\n';
    writeFixture(root, 'src/example.ts', before);
    const result = applyRepair({
      ...input(root, [
        action({
          target: {
            filePath: 'src/example.ts',
            line: 2,
            expectedText: '@ts-ignore',
            replacementText: '@ts-expect-error',
          },
        }),
      ]),
      actionId: 'replace-ts-ignore',
      force: true,
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, 'src/example.ts'), 'utf8')).toBe(
      '// first\n// @ts-expect-error\r\nlegacy();\n',
    );
  });

  it('applies and verifies through an injected verifier', async () => {
    writeFixture(root, 'src/example.ts', '// @ts-ignore -- legacy third-party type\nlegacy();\n');
    const verification: RepairVerificationResult = {
      status: 'verified',
      coverage: 'full',
      scope: {
        tool: 'fit',
        ruleId: 'fit:typescript-directive-hygiene',
        files: ['src/example.ts'],
        checkRan: true,
        changedImpacted: true,
        fallback: 'targeted',
      },
      commands: [],
      remainingFindings: [],
    };
    const runner = SUCCESS_RUNNER;

    const result = await applyAndVerifyRepair({
      ...input(root, [action({})]),
      actionId: 'replace-ts-ignore',
      force: true,
      verificationRunner: runner,
      cliEntrypoint: '/repo/packages/cli/dist/index.js',
      configPath: '/repo/custom opensip.yml',
      timeoutMs: 5,
      verifier: ({ applyResult, runner: receivedRunner, cliEntrypoint, configPath, timeoutMs }) => {
        expect(receivedRunner).toBe(runner);
        expect(cliEntrypoint).toBe('/repo/packages/cli/dist/index.js');
        expect(configPath).toBe('/repo/custom opensip.yml');
        expect(timeoutMs).toBe(5);
        return Promise.resolve({
          ...verification,
          commands: [
            {
              tool: 'fit',
              args: ['fit', '--check', applyResult.signal.ruleId, '--changed', '--json'],
              cwd: root,
              check: applyResult.signal.ruleId,
            },
          ],
        });
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe('repair-apply-verify');
    expect(result.value.status).toBe('applied');
    expect(result.value.verification.status).toBe('verified');
    expect(readFileSync(join(root, 'src/example.ts'), 'utf8')).toContain('@ts-expect-error');
  });

  it('skips verification for a refused repair action', async () => {
    const result = await applyAndVerifyRepair({
      ...input(root, [
        action({
          id: 'add-suppression-reason',
          kind: 'manual-text-edit',
          title: 'Add reason',
          autofixable: false,
          target: { filePath: 'src/example.ts', line: 1 },
        }),
      ]),
      actionId: 'add-suppression-reason',
      force: true,
      verifier: () => Promise.reject(new Error('verifier should not run')),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('refused');
    expect(result.value.verification.status).toBe('skipped');
    expect(result.value.verification.failure?.code).toBe('action-not-autofixable');
  });

  it('previews package.json dependency removal', () => {
    writeFixture(
      root,
      'package.json',
      JSON.stringify(
        {
          dependencies: {
            lodash: '^4.0.0',
            react: '^19.0.0',
          },
        },
        null,
        2,
      ) + '\n',
    );
    const remove = action({
      id: 'remove-unused-dependency',
      kind: 'package-json-remove-dependency',
      title: 'Remove lodash',
      target: {
        filePath: 'package.json',
        packageName: 'lodash',
        dependencySection: 'dependencies',
      },
    });

    const result = previewRepair(input(root, [remove]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('previewed');
    expect(result.value.changes[0]?.diff).toContain('-    "lodash"');
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('"lodash"');
  });

  it('reports selector and action selection failures before planning file changes', () => {
    const base = input(root, [action({})]);

    for (const [selector, code] of [
      ['sig-1', 'invalid-signal-selector'],
      ['index:-1', 'invalid-signal-selector'],
      ['index:7', 'signal-not-found'],
      ['id:missing', 'signal-not-found'],
      ['unknown:sig-1', 'invalid-signal-selector'],
      ['fingerprint:', 'invalid-signal-selector'],
    ] as const) {
      const result = previewRepair({ ...base, selector });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe(code);
    }

    const ambiguousSignal = previewRepair({
      ...base,
      signals: [signal([action({})]), signal([action({})])],
      selector: 'id:sig-1',
    });
    expect(ambiguousSignal.ok).toBe(false);
    if (!ambiguousSignal.ok) expect(ambiguousSignal.error.code).toBe('signal-ambiguous');

    const ambiguousAction = previewRepair(
      input(root, [action({ id: 'a' }), action({ id: 'b', title: 'Second' })]),
    );
    expect(ambiguousAction.ok).toBe(false);
    if (!ambiguousAction.ok) expect(ambiguousAction.error.code).toBe('action-ambiguous');

    const missingAction = previewRepair({
      ...base,
      actionId: 'missing-action',
    });
    expect(missingAction.ok).toBe(false);
    if (!missingAction.ok) expect(missingAction.error.code).toBe('action-not-found');
  });

  it('classifies text replacement stale and already-applied targets', () => {
    writeFixture(
      root,
      'src/example.ts',
      '// @ts-expect-error -- legacy third-party type\nlegacy();\n',
    );
    const alreadyApplied = previewRepair(input(root, [action({})]));
    expect(alreadyApplied.ok).toBe(true);
    if (alreadyApplied.ok) expect(alreadyApplied.value.status).toBe('already-applied');

    const missingReplacement = previewRepair(
      input(root, [
        action({
          target: {
            filePath: 'src/example.ts',
            line: 1,
            expectedText: '@ts-ignore',
          },
        }),
      ]),
    );
    expect(missingReplacement.ok).toBe(false);
    if (!missingReplacement.ok) expect(missingReplacement.error.code).toBe('invalid-target');

    const staleLine = previewRepair(
      input(root, [
        action({
          target: {
            filePath: 'src/example.ts',
            line: 20,
            expectedText: '@ts-ignore',
            replacementText: '@ts-expect-error',
          },
        }),
      ]),
    );
    expect(staleLine.ok).toBe(false);
    if (!staleLine.ok) expect(staleLine.error.message).toContain('target line 20');

    writeFixture(root, 'src/example.ts', '// no directive here\nlegacy();\n');
    const staleText = previewRepair(input(root, [action({})]));
    expect(staleText.ok).toBe(false);
    if (!staleText.ok) expect(staleText.error.message).toContain('expected text was not found');
  });

  it('handles dependency removal edge cases without corrupting package.json', () => {
    const remove = action({
      id: 'remove-unused-dependency',
      kind: 'package-json-remove-dependency',
      title: 'Remove lodash',
      target: {
        filePath: 'package.json',
        packageName: 'lodash',
        dependencySection: 'dependencies',
      },
    });

    writeFixture(root, 'package.json', '{"devDependencies":{"lodash":"^4.0.0"}}\n');
    const missingSection = previewRepair(input(root, [remove]));
    expect(missingSection.ok).toBe(true);
    if (missingSection.ok) expect(missingSection.value.status).toBe('already-applied');

    writeFixture(root, 'package.json', '{not json');
    const invalidJson = previewRepair(input(root, [remove]));
    expect(invalidJson.ok).toBe(false);
    if (!invalidJson.ok) expect(invalidJson.error.code).toBe('invalid-target');

    writeFixture(root, 'package.json', '{"dependencies":{"lodash":"^4.0.0"}}\n');
    const singleLine = previewRepair(input(root, [remove]));
    expect(singleLine.ok).toBe(false);
    if (!singleLine.ok) expect(singleLine.error.message).toContain('multiline JSON object');

    writeFixture(
      root,
      'package.json',
      [
        '{',
        '  "dependencies": {',
        '    "lodash": "^4.0.0",',
        '    "lodash": "^4.1.0"',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const duplicate = previewRepair(input(root, [remove]));
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok)
      expect(duplicate.error.message).toContain('expected exactly one lodash entry');

    const invalidTarget = previewRepair(
      input(root, [
        action({
          id: 'remove-unused-dependency',
          kind: 'package-json-remove-dependency',
          title: 'Remove lodash',
          target: { filePath: 'package.json', packageName: 'lodash' },
        }),
      ]),
    );
    expect(invalidTarget.ok).toBe(false);
    if (!invalidTarget.ok) expect(invalidTarget.error.code).toBe('invalid-target');
  });

  it('removes package dependencies from different sections and cleans trailing commas', () => {
    writeFixture(
      root,
      'package.json',
      [
        '{',
        '  "dependencies": {',
        '    "alpha": "^1.0.0",',
        '    "lodash": "^4.0.0"',
        '  },',
        '  "devDependencies": {',
        '    "vitest": "^4.0.0"',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const removeDependency = action({
      id: 'remove-unused-dependency',
      kind: 'package-json-remove-dependency',
      title: 'Remove lodash',
      target: {
        filePath: 'package.json',
        packageName: 'lodash',
        dependencySection: 'dependencies',
      },
    });

    const dep = applyRepair({
      ...input(root, [removeDependency]),
      actionId: 'remove-unused-dependency',
      force: true,
    });
    expect(dep.ok).toBe(true);
    const afterDep = readFileSync(join(root, 'package.json'), 'utf8');
    expect(afterDep).not.toContain('"lodash"');
    expect(JSON.parse(afterDep)).toMatchObject({
      dependencies: { alpha: '^1.0.0' },
      devDependencies: { vitest: '^4.0.0' },
    });

    const removeDevDependency = action({
      id: 'remove-unused-dependency',
      kind: 'package-json-remove-dependency',
      title: 'Remove vitest',
      target: {
        filePath: 'package.json',
        packageName: 'vitest',
        dependencySection: 'devDependencies',
      },
    });
    const dev = previewRepair(input(root, [removeDevDependency]));
    expect(dev.ok).toBe(true);
    if (dev.ok) expect(dev.value.changes[0]?.diff).toContain('-    "vitest"');
  });

  it('removes a dependency without normalizing mixed line endings', () => {
    const before = [
      '{\r\n',
      '  "dependencies": {\n',
      '    "alpha": "^1.0.0",\r\n',
      '    "lodash": "^4.0.0"\n',
      '  }\r\n',
      '}\n',
    ].join('');
    writeFixture(root, 'package.json', before);
    const remove = action({
      id: 'remove-unused-dependency',
      kind: 'package-json-remove-dependency',
      title: 'Remove lodash',
      target: {
        filePath: 'package.json',
        packageName: 'lodash',
        dependencySection: 'dependencies',
      },
    });

    const result = applyRepair({
      ...input(root, [remove]),
      actionId: 'remove-unused-dependency',
      force: true,
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(
      ['{\r\n', '  "dependencies": {\n', '    "alpha": "^1.0.0"\r\n', '  }\r\n', '}\n'].join(''),
    );
  });

  it('rejects dependency removal when the package section is not an object', () => {
    writeFixture(root, 'package.json', '{"dependencies":[]}\n');
    const remove = action({
      id: 'remove-unused-dependency',
      kind: 'package-json-remove-dependency',
      title: 'Remove lodash',
      target: {
        filePath: 'package.json',
        packageName: 'lodash',
        dependencySection: 'dependencies',
      },
    });

    const result = previewRepair(input(root, [remove]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unsupported-layout');
    expect(result.error.message).toContain('dependencies must be a JSON object');
  });

  it('returns a structured refusal for advisory actions', () => {
    const result = previewRepair(
      input(root, [
        action({
          id: 'add-suppression-reason',
          kind: 'manual-text-edit',
          title: 'Add reason',
          autofixable: false,
          target: { filePath: 'src/example.ts', line: 1 },
        }),
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('refused');
    expect(result.value.refusal?.code).toBe('action-not-autofixable');
  });

  it('returns structured refusals for reserved and unsupported action ids', () => {
    for (const [id, code] of [
      ['normalize-generated-config', 'action-reserved'],
      ['future-action', 'action-unsupported'],
    ] as const) {
      const result = previewRepair(
        input(root, [
          action({
            id,
            kind: 'manual-text-edit',
            title: id,
            autofixable: true,
          }),
        ]),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.refusal?.code).toBe(code);
    }
  });

  it('rejects repair targets outside the project root', () => {
    const unsafe = action({
      target: {
        filePath: '../outside.ts',
        line: 1,
        expectedText: '@ts-ignore',
        replacementText: '@ts-expect-error',
      },
    });

    const result = previewRepair(input(root, [unsafe]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unsafe-path');
  });

  it('rejects repair targets that escape through a symlinked directory', () => {
    const outside = mkdtempSync(join(tmpdir(), 'opensip-repair-outside-'));
    try {
      writeFixture(outside, 'outside.ts', '// @ts-ignore -- legacy third-party type\nlegacy();\n');
      symlinkSync(outside, join(root, 'linked-dir'), 'dir');
      const unsafe = action({
        target: {
          filePath: 'linked-dir/outside.ts',
          line: 1,
          expectedText: '@ts-ignore',
          replacementText: '@ts-expect-error',
        },
      });

      const result = previewRepair(input(root, [unsafe]));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('unsafe-path');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
