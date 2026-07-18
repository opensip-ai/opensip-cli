import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createInitAuthoredPlan } from '../init-authored-plan.js';

import type { ToolScaffold } from '../../shared.js';
import type * as SnapshotModule from '../init-authored-plan-snapshot.js';

let afterSnapshot: (() => void) | undefined;

vi.mock('../init-authored-plan-snapshot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SnapshotModule>();
  return {
    ...actual,
    readInitAuthoredSnapshot: (
      input: Parameters<typeof actual.readInitAuthoredSnapshot>[0],
    ): ReturnType<typeof actual.readInitAuthoredSnapshot> => {
      const snapshot = actual.readInitAuthoredSnapshot(input);
      afterSnapshot?.();
      return snapshot;
    },
  };
});

const EXAMPLE_CONTENT = '// exact rendered scaffold\nexport const value = 1;\n';
const EXAMPLE_PATH = 'opensip-cli/fit/checks/example-check-typescript.mjs';

let projectRoot: string;

function fixtureTool(): ToolScaffold {
  return {
    identity: {
      stableId: '00000000-0000-4000-8000-0000000000f1',
      name: 'fitness',
      version: '1.0.0',
    },
    layout: {
      domain: 'fit',
      userSubdirs: ['checks', 'recipes'],
    },
    scaffoldExamples: () => [
      {
        kind: 'checks',
        filename: 'example-check-typescript.mjs',
        content: EXAMPLE_CONTENT,
        stableId: 'example-typescript',
      },
    ],
    stableExampleIds: () => ['example-typescript'],
    scaffoldConfigBlock: () => 'fitness:\n  failOnErrors: true\n',
  };
}

function writeProjectFile(relativePath: string, content: string): void {
  const path = join(projectRoot, ...relativePath.split('/'));
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function createPlan() {
  return createInitAuthoredPlan({
    projectRoot,
    languages: ['typescript'],
    mode: 'fresh',
    toolScaffolds: [fixtureTool()],
  });
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'opensip-authored-presentation-'));
  afterSnapshot = undefined;
});

afterEach(() => {
  afterSnapshot = undefined;
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('Init authored plan presentation', () => {
  it('classifies only captured snapshot bytes without re-walking changed customer paths', () => {
    writeProjectFile(EXAMPLE_PATH, EXAMPLE_CONTENT);
    afterSnapshot = () => {
      writeProjectFile(EXAMPLE_PATH, '// customer edit after snapshot\n');
      writeProjectFile('opensip-cli/late-file.mjs', 'export const late = true;\n');
    };

    const plan = createPlan();

    expect(readFileSync(join(projectRoot, ...EXAMPLE_PATH.split('/')), 'utf8')).toContain(
      'customer edit',
    );
    expect(plan.presentation?.preExistingFiles).toEqual([
      {
        path: join(projectRoot, ...EXAMPLE_PATH.split('/')),
        classification: 'scaffolded',
      },
    ]);
    expect(
      plan.presentation?.preExistingFiles.some((file) => file.path.endsWith('late-file.mjs')),
    ).toBe(false);
  });

  it('freezes the augmented plan and every attempt-local presentation structure', () => {
    writeProjectFile('opensip-cli/customer-note.txt', 'preserve me\n');

    const plan = createPlan();
    const presentation = plan.presentation;

    expect(presentation).toBeDefined();
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(presentation)).toBe(true);
    expect(Object.isFrozen(presentation?.preExistingFiles)).toBe(true);
    expect(presentation?.preExistingFiles.every((file) => Object.isFrozen(file))).toBe(true);
    expect(Object.isFrozen(presentation?.agentGuidance)).toBe(true);
    expect(Object.isFrozen(presentation?.agentGuidance.targets)).toBe(true);
    expect(presentation?.agentGuidance.targets.every((target) => Object.isFrozen(target))).toBe(
      true,
    );
  });
});
