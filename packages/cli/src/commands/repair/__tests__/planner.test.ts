import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyRepair } from '../apply.js';
import { previewRepair } from '../planner.js';

import type { RepairBuildInput } from '../types.js';
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
