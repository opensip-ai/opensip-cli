import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  INIT_AUTHORED_PLAN_CAPS,
  createInitAuthoredPlan,
  decodeInitAuthoredPlanBlob,
  encodeAuthoredReplayManifest,
  parseAuthoredReplayManifest,
} from '../init-authored-plan.js';

import type { ToolScaffold } from '../../shared.js';
import type { InitAuthoredMode, InitAuthoredPlan } from '../init-authored-plan.js';
import type { ScaffoldFile } from '@opensip-cli/core';

const LANGUAGES = ['typescript'] as const;
const SECRET_EXAMPLE = '// exact-example-bytes-not-in-manifest\nexport const value = 1;\n';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'opensip-authored-plan-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function fixtureTool(
  overrides: {
    readonly stableId?: string;
    readonly name?: string;
    readonly domain?: string;
    readonly version?: string;
    readonly examples?: readonly ScaffoldFile[];
    readonly configBlock?: string;
    readonly withExamplesHook?: boolean;
  } = {},
): ToolScaffold {
  const examples = overrides.examples ?? [
    {
      kind: 'checks',
      filename: 'example-check-typescript.mjs',
      content: SECRET_EXAMPLE,
      stableId: 'example-typescript',
    },
  ];
  return {
    identity: {
      stableId: overrides.stableId ?? '00000000-0000-4000-8000-0000000000f1',
      name: overrides.name ?? 'fitness',
      version: overrides.version ?? '1.0.0',
    },
    layout: {
      domain: overrides.domain ?? 'fit',
      userSubdirs: ['checks', 'recipes'],
    },
    ...(overrides.withExamplesHook === false ? {} : { scaffoldExamples: () => examples }),
    stableExampleIds: () => examples.map((example) => example.stableId),
    scaffoldConfigBlock: () =>
      overrides.configBlock ?? 'fitness:\n  failOnErrors: true\n  failOnWarnings: false\n',
  };
}

function build(
  mode: InitAuthoredMode,
  toolScaffolds: readonly ToolScaffold[] = [fixtureTool()],
  hooks?: Parameters<typeof createInitAuthoredPlan>[0]['hooks'],
): InitAuthoredPlan {
  return createInitAuthoredPlan({
    projectRoot,
    languages: LANGUAGES,
    mode,
    toolScaffolds,
    ...(hooks === undefined ? {} : { hooks }),
  });
}

function mutation(plan: InitAuthoredPlan, path: string) {
  const found = plan.mutations.find((entry) => entry.path === path);
  if (found === undefined) throw new Error(`Missing mutation ${path}`);
  return found;
}

function writeProjectFile(path: string, content: string | Buffer): void {
  const absolute = join(projectRoot, ...path.split('/'));
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
}

describe('Init authored replay plan', () => {
  it('plans pristine state without writing and evaluates every Tool hook once', () => {
    const examples = vi.fn(() => [
      {
        kind: 'checks',
        filename: 'example-check-typescript.mjs',
        content: SECRET_EXAMPLE,
        stableId: 'example-typescript',
      },
    ]);
    const stableIds = vi.fn(() => ['example-typescript']);
    const config = vi.fn(() => 'fitness:\n  failOnErrors: true\n');
    const tool = fixtureTool();
    const plan = build('fresh', [
      {
        ...tool,
        scaffoldExamples: examples,
        stableExampleIds: stableIds,
        scaffoldConfigBlock: config,
      },
    ]);

    expect(readdirSync(projectRoot)).toEqual([]);
    expect(examples).toHaveBeenCalledTimes(1);
    expect(stableIds).toHaveBeenCalledTimes(1);
    expect(config).toHaveBeenCalledTimes(1);
    expect(mutation(plan, 'opensip-cli.config.yml').action).toBe('create');
    expect(mutation(plan, 'opensip-cli/fit/checks/example-check-typescript.mjs').action).toBe(
      'create',
    );
    expect(mutation(plan, '.gitignore').action).toBe('create');
    expect(mutation(plan, 'AGENTS.md').action).toBe('create');
    expect(plan.inputs.tools).toEqual([tool.identity]);
    expect(plan.replayManifestBytes).not.toContain(SECRET_EXAMPLE.trim());
    expect(plan.replayManifestBytes).not.toContain(projectRoot);
  });

  it('refreshes only managed root documents while preserving config and authored files', () => {
    writeProjectFile('opensip-cli.config.yml', 'custom: true\n');
    writeProjectFile('opensip-cli/fit/checks/custom.mjs', 'export default 1;\n');
    writeProjectFile('AGENTS.md', '# Existing instructions\n');

    const plan = build('refresh');

    expect(mutation(plan, 'opensip-cli.config.yml').action).toBe('preserve');
    expect(mutation(plan, 'opensip-cli/fit/checks/custom.mjs').action).toBe('preserve');
    expect(mutation(plan, 'AGENTS.md').action).toBe('replace');
    expect(mutation(plan, '.gitignore').action).toBe('create');
    expect(plan.mutations.some((entry) => entry.path.includes('example-check-typescript'))).toBe(
      false,
    );
  });

  it.each(['refresh', 'remove'] as const)(
    'preserves generated and dependency roots opaquely during %s',
    (mode) => {
      writeProjectFile('opensip-cli.config.yml', 'custom: true\n');
      writeProjectFile('opensip-cli/fit/dist/bundle.js', 'generated output\n');
      const dependencyTarget = join(projectRoot, 'external-dependencies');
      mkdirSync(dependencyTarget, { recursive: true });
      writeFileSync(join(dependencyTarget, 'sentinel.txt'), 'dependency data\n');
      if (process.platform === 'win32') {
        mkdirSync(join(projectRoot, 'opensip-cli/fit/node_modules'), {
          recursive: true,
        });
      } else {
        symlinkSync(dependencyTarget, join(projectRoot, 'opensip-cli/fit/node_modules'));
      }

      const plan = build(mode);

      expect(
        plan.mutations.some(
          (entry) =>
            entry.path === 'opensip-cli/fit/dist' ||
            entry.path.startsWith('opensip-cli/fit/dist/') ||
            entry.path === 'opensip-cli/fit/node_modules' ||
            entry.path.startsWith('opensip-cli/fit/node_modules/'),
        ),
      ).toBe(false);
      expect(mutation(plan, 'opensip-cli/fit').action).toBe('preserve');
      expect(plan.presentation?.workingDirState).toBe('fully-initialized');
      expect(readFileSync(join(dependencyTarget, 'sentinel.txt'), 'utf8')).toBe(
        'dependency data\n',
      );
    },
  );

  it('permits a durable language-neutral refresh without invoking Tool render callbacks', () => {
    writeProjectFile('opensip-cli.config.yml', 'custom: true\n');
    writeProjectFile('opensip-cli/fit/checks/custom.mjs', 'export default 1;\n');
    const examples = vi.fn(() => [
      {
        kind: 'checks' as const,
        filename: 'must-not-render.mjs',
        content: SECRET_EXAMPLE,
        stableId: 'must-not-render',
      },
    ]);
    const stableIds = vi.fn(() => ['must-not-render']);
    const config = vi.fn(() => 'fitness:\n  failOnErrors: true\n');
    const tool = {
      ...fixtureTool(),
      scaffoldExamples: examples,
      stableExampleIds: stableIds,
      scaffoldConfigBlock: config,
    };

    const plan = createInitAuthoredPlan({
      projectRoot,
      languages: [],
      mode: 'refresh',
      toolScaffolds: [tool],
    });

    expect(plan.inputs).toMatchObject({
      languages: [],
      mode: 'refresh',
      tools: [tool.identity],
    });
    expect(parseAuthoredReplayManifest(plan.replayManifestBytes).inputs.languages).toEqual([]);
    expect(mutation(plan, 'opensip-cli.config.yml').action).toBe('preserve');
    expect(mutation(plan, 'opensip-cli/fit/checks/custom.mjs').action).toBe('preserve');
    expect(plan.mutations.some((entry) => entry.path.includes('must-not-render'))).toBe(false);
    expect(plan.presentation?.preExistingFiles).toEqual([]);
    expect(examples).not.toHaveBeenCalled();
    expect(stableIds).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
  });

  it.each(['fresh', 'keep', 'remove'] as const)(
    'rejects an empty language set for %s plans',
    (mode) => {
      expect(() =>
        createInitAuthoredPlan({
          projectRoot,
          languages: [],
          mode,
          toolScaffolds: [fixtureTool()],
        }),
      ).toThrow(/languages must be a nonempty supported set/iu);
    },
  );

  it('keeps custom targets and creates only missing Tool examples', () => {
    const examples: readonly ScaffoldFile[] = [
      {
        kind: 'checks',
        filename: 'example-check-typescript.mjs',
        content: SECRET_EXAMPLE,
        stableId: 'example-typescript',
      },
      {
        kind: 'recipes',
        filename: 'example-recipe.mjs',
        content: 'export default {};\n',
        stableId: 'example-recipe',
      },
    ];
    writeProjectFile('opensip-cli.config.yml', 'customer-config: true\n');
    writeProjectFile('opensip-cli/fit/checks/example-check-typescript.mjs', '// customer edited\n');
    writeProjectFile('opensip-cli/notes.txt', 'customer note\n');

    const plan = build('keep', [fixtureTool({ examples })]);

    expect(mutation(plan, 'opensip-cli.config.yml').action).toBe('preserve');
    expect(mutation(plan, 'opensip-cli/fit/checks/example-check-typescript.mjs').action).toBe(
      'preserve',
    );
    expect(mutation(plan, 'opensip-cli/fit/recipes/example-recipe.mjs').action).toBe('create');
    expect(mutation(plan, 'opensip-cli/notes.txt').action).toBe('preserve');
  });

  it('removes the authored tree exactly while immutably excluding .runtime', () => {
    writeProjectFile('opensip-cli.config.yml', 'old: true\n');
    writeProjectFile('opensip-cli/custom/note.bin', Buffer.from([0, 1, 2, 255]));
    writeProjectFile('opensip-cli/.runtime/datastore.sqlite', 'runtime-evidence');

    const plan = build('remove');
    const custom = mutation(plan, 'opensip-cli/custom/note.bin');

    expect(custom.action).toBe('delete');
    expect(custom.preimageBlob).not.toBeNull();
    expect(
      decodeInitAuthoredPlanBlob(plan, 'preimage', custom.preimageBlob ?? '').equals(
        Buffer.from([0, 1, 2, 255]),
      ),
    ).toBe(true);
    expect(plan.mutations.some((entry) => entry.path.includes('.runtime'))).toBe(false);
    expect(readFileSync(join(projectRoot, 'opensip-cli/.runtime/datastore.sqlite'), 'utf8')).toBe(
      'runtime-evidence',
    );
    expect(mutation(plan, 'opensip-cli.config.yml').action).toBe('replace');
  });

  it('captures config, gitignore, and every eligible managed guidance target', () => {
    writeProjectFile('.gitignore', 'node_modules/\n');
    writeProjectFile('CLAUDE.md', '# Customer rules\n');
    mkdirSync(join(projectRoot, '.cursor/rules'), { recursive: true });

    const plan = build('fresh');
    const gitignore = mutation(plan, '.gitignore');
    const claude = mutation(plan, 'CLAUDE.md');
    const cursor = mutation(plan, '.cursor/rules/opensip.mdc');

    expect(
      decodeInitAuthoredPlanBlob(plan, 'desired', gitignore.desiredBlob ?? '').toString(),
    ).toContain('opensip-cli/.runtime/');
    expect(
      decodeInitAuthoredPlanBlob(plan, 'desired', claude.desiredBlob ?? '').toString(),
    ).toContain('# Customer rules');
    expect(cursor.action).toBe('create');
    expect(plan.mutations.some((entry) => entry.path === '.github/copilot-instructions.md')).toBe(
      false,
    );
  });

  it('produces deterministic canonical bytes and changes digest for Tool order/defaults', () => {
    const alpha = fixtureTool();
    const beta = fixtureTool({
      stableId: '00000000-0000-4000-8000-0000000000f2',
      name: 'simulation',
      domain: 'sim',
      withExamplesHook: false,
      configBlock: '',
    });
    const first = build('fresh', [alpha, beta]);
    const repeated = build('fresh', [alpha, beta]);
    const reordered = build('fresh', [beta, alpha]);
    const changedDefault = build('fresh', [
      fixtureTool({ configBlock: 'fitness:\n  failOnErrors: false\n' }),
      beta,
    ]);

    expect(repeated.replayManifestBytes).toBe(first.replayManifestBytes);
    expect(repeated.digest).toBe(first.digest);
    expect(reordered.digest).not.toBe(first.digest);
    expect(changedDefault.digest).not.toBe(first.digest);
    expect(first.replayManifestDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.mutations.map((entry) => entry.path)).toEqual(
      [...first.mutations.map((entry) => entry.path)].sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      ),
    );
  });

  it('stores complete replay records and rejects noncanonical or tampered manifests', () => {
    const plan = build('fresh');
    const parsed = parseAuthoredReplayManifest(plan.replayManifestBytes);

    expect(parsed).toEqual(plan.replayManifest);
    expect(
      parsed.mutations.every(
        (entry) =>
          entry.preimage.digest !== undefined &&
          entry.desired.digest !== undefined &&
          entry.targetType !== undefined &&
          entry.targetMode !== undefined,
      ),
    ).toBe(true);
    expect(() => parseAuthoredReplayManifest(` ${plan.replayManifestBytes}`)).toThrow(/canonical/u);

    const unknown = JSON.parse(plan.replayManifestBytes) as Record<string, unknown>;
    unknown.extra = true;
    expect(() => parseAuthoredReplayManifest(JSON.stringify(unknown))).toThrow(
      /unknown or missing/u,
    );

    const unsafe = JSON.parse(plan.replayManifestBytes) as {
      mutations: { path: string }[];
    };
    unsafe.mutations[0].path = '/absolute/customer/path';
    expect(() => parseAuthoredReplayManifest(JSON.stringify(unsafe))).toThrow(/unsafe/u);

    const swapped = JSON.parse(plan.replayManifestBytes) as {
      mutations: unknown[];
    };
    const firstMutation = swapped.mutations[0];
    swapped.mutations[0] = swapped.mutations[1];
    swapped.mutations[1] = firstMutation;
    expect(() => parseAuthoredReplayManifest(JSON.stringify(swapped))).toThrow(
      /sequence|canonical/u,
    );
  });

  it('enforces mutation, path, collision, and runtime-target caps before returning a plan', () => {
    const tooMany = Array.from(
      { length: INIT_AUTHORED_PLAN_CAPS.maxMutations + 1 },
      (_, index): ScaffoldFile => ({
        kind: 'checks',
        filename: `example-${String(index).padStart(5, '0')}.mjs`,
        content: '',
        stableId: `example-${String(index)}`,
      }),
    );
    expect(() => build('fresh', [fixtureTool({ examples: tooMany })])).toThrow(
      /traversal cap|mutation count/u,
    );
    expect(() =>
      build('fresh', [
        fixtureTool({
          examples: [
            {
              kind: 'checks',
              filename: 'Foo.mjs',
              content: '',
              stableId: 'one',
            },
            {
              kind: 'checks',
              filename: 'foo.mjs',
              content: '',
              stableId: 'two',
            },
          ],
        }),
      ]),
    ).toThrow(/case-folded|duplicate/u);
    expect(() =>
      build('fresh', [
        fixtureTool({
          examples: [
            {
              kind: 'checks',
              filename: `${'x'.repeat(INIT_AUTHORED_PLAN_CAPS.maxPathBytes)}.mjs`,
              content: '',
              stableId: 'long',
            },
          ],
        }),
      ]),
    ).toThrow(/path/u);
    expect(() => build('fresh', [fixtureTool({ domain: '.runtime', examples: [] })])).toThrow(
      /immutable/u,
    );
  });

  it('rejects oversized, mutated, linked, special, and unsafe preimages', () => {
    writeProjectFile('opensip-cli/existing.txt', 'existing\n');
    let directoryMutated = false;
    expect(() =>
      build('fresh', undefined, {
        afterDirectoryRead(path) {
          if (path === 'opensip-cli' && !directoryMutated) {
            directoryMutated = true;
            writeProjectFile('opensip-cli/raced.txt', 'raced\n');
          }
        },
      }),
    ).toThrow(/changed/u);
    rmSync(join(projectRoot, 'opensip-cli/raced.txt'));

    writeProjectFile('.gitignore', 'initial\n');
    expect(() =>
      build('fresh', undefined, {
        afterFileRead(path) {
          if (path === '.gitignore') writeFileSync(join(projectRoot, '.gitignore'), 'changed\n');
        },
      }),
    ).toThrow(/changed/u);

    rmSync(join(projectRoot, '.gitignore'));
    writeProjectFile('source.txt', 'linked\n');
    linkSync(join(projectRoot, 'source.txt'), join(projectRoot, '.gitignore'));
    expect(() => build('fresh')).toThrow(/hard-linked/u);

    rmSync(join(projectRoot, '.gitignore'));
    symlinkSync('source.txt', join(projectRoot, '.gitignore'));
    expect(() => build('fresh')).toThrow(/symbolic link|safely open/u);

    rmSync(join(projectRoot, '.gitignore'));
    writeProjectFile('.gitignore', 'unsafe\n');
    chmodSync(join(projectRoot, '.gitignore'), 0o666);
    expect(() => build('fresh')).toThrow(/writable/u);

    rmSync(join(projectRoot, '.gitignore'));
    execFileSync('mkfifo', [join(projectRoot, '.gitignore')]);
    expect(() => build('fresh')).toThrow(/unsupported file type|must be a file/u);
  });

  it('rejects individual files above the named cap before allocating their content', () => {
    writeProjectFile('.gitignore', '');
    truncateSync(join(projectRoot, '.gitignore'), INIT_AUTHORED_PLAN_CAPS.maxFileBytes + 1);
    expect(() => build('fresh')).toThrow(/exceeds/u);
  });

  it('round-trips only canonical manifests produced by the closed codec', () => {
    const plan = build('fresh');
    const parsed = parseAuthoredReplayManifest(plan.replayManifestBytes);
    expect(encodeAuthoredReplayManifest(parsed)).toBe(plan.replayManifestBytes);
  });
});
