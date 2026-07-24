import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyGlobalExcludesBounded,
  MAX_BOUNDED_BRACE_EXPANSIONS,
  MAX_BOUNDED_GLOBAL_FILTER_INPUTS,
  MAX_BOUNDED_GLOBAL_FILTER_PATH_BYTES,
  MAX_BOUNDED_GLOBAL_EXCLUDES,
  MAX_BOUNDED_PATTERN_BYTES,
  MAX_BOUNDED_TARGET_EXCLUDES,
  MAX_BOUNDED_TARGET_INCLUDES,
  MAX_BOUNDED_TARGET_RESULTS,
  MAX_BOUNDED_TARGETS,
  MAX_BOUNDED_TOTAL_EXPANDED_ALTERNATIVES,
  MAX_BOUNDED_TOTAL_EXPANDED_BYTES,
  resolveTargetMembershipsBounded,
  resolveTargetsBounded,
} from '../bounded-resolve.js';
import {
  TARGET_WALK_DIRECTORY_READ_BUFFER_SIZE,
  TARGET_WALK_MAX_DEPTH,
  TARGET_WALK_MAX_ENTRIES_PER_DIRECTORY,
  TARGET_WALK_MAX_FRONTIER_ENTRIES,
  compareTargetFilesystemEntries,
  walkTargetFilesystem,
} from '../filesystem-walk.js';
import { applyGlobalExcludes, resolveTargets } from '../resolve.js';

import type { TargetView } from '@opensip-cli/core';

let testDir: string;
const extraDirectories: string[] = [];

function fixture(relativePath: string, rootDir = testDir): string {
  const absolutePath = join(rootDir, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, 'fixture');
  return absolutePath;
}

function target(
  include: readonly string[] = ['src/**/*.ts'],
  exclude: readonly string[] = [],
  name = 'source',
): TargetView {
  return {
    config: { name, description: name, include, exclude },
  };
}

function relativeFiles(files: readonly string[], rootDir = testDir): readonly string[] {
  return files.map((file) => file.slice(rootDir.length + 1).replaceAll('\\', '/'));
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  extraDirectories.push(directory);
  return directory;
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-targeting-bounded-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  for (const directory of extraDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolveTargetsBounded', () => {
  it('snapshots hostile arrays and bounds exactly once without invoking overridden iteration', async () => {
    fixture('src/a.ts');
    fixture('src/b.ts');
    const include = ['src/**/*.ts'];
    Object.defineProperty(include, 'map', {
      value: () => {
        throw new Error('hostile include map');
      },
    });
    const selectedTargets = [target(include)];
    Object.defineProperty(selectedTargets, Symbol.iterator, {
      value: () => {
        throw new Error('hostile target iterator');
      },
    });
    const globalExcludes: string[] = [];
    Object.defineProperty(globalExcludes, 'map', {
      value: () => {
        throw new Error('hostile exclude map');
      },
    });
    let maxResultReads = 0;
    const options = Object.defineProperty({}, 'maxResults', {
      enumerable: true,
      get: () => {
        maxResultReads += 1;
        return maxResultReads === 1 ? 1 : MAX_BOUNDED_TARGET_RESULTS;
      },
    }) as { readonly maxResults: number };

    const resolved = await resolveTargetsBounded(selectedTargets, testDir, globalExcludes, options);

    expect(relativeFiles(resolved.files)).toEqual(['src/a.ts']);
    expect(resolved).toMatchObject({ capped: true, cancelled: false });
    expect(maxResultReads).toBe(1);
  });

  it('rejects a non-numeric proxy length without coercing it into an allocation size', async () => {
    let coercions = 0;
    const hostileLength = {
      valueOf: () => {
        coercions += 1;
        return coercions === 1 ? 0 : 1000;
      },
    };
    const selectedTargets = new Proxy([target()], {
      get: (values, property, receiver) =>
        property === 'length' ? hostileLength : Reflect.get(values, property, receiver),
    });

    await expect(
      resolveTargetsBounded(selectedTargets, join(testDir, 'missing'), [], { maxResults: 1 }),
    ).rejects.toThrow(/valid array length/);
    expect(coercions).toBe(0);
  });

  it('retains the same code-point prefix under perturbed real enumeration order', async () => {
    const firstRoot = temporaryDirectory('opensip-target-order-first-');
    const secondRoot = temporaryDirectory('opensip-target-order-second-');
    const bmp = '\uE000.ts';
    const astralLow = '\u{10000}.ts';
    const astralHigh = '\u{1F600}.ts';
    for (const name of [astralHigh, astralLow, bmp]) fixture(`src/${name}`, firstRoot);
    for (const name of [bmp, astralLow, astralHigh]) fixture(`src/${name}`, secondRoot);

    const first = await resolveTargetsBounded([target()], firstRoot, [], {
      maxResults: 2,
    });
    const second = await resolveTargetsBounded([target()], secondRoot, [], {
      maxResults: 2,
    });

    expect(relativeFiles(first.files, firstRoot)).toEqual([`src/${bmp}`, `src/${astralLow}`]);
    expect(relativeFiles(second.files, secondRoot)).toEqual([`src/${bmp}`, `src/${astralLow}`]);
    expect(first).toMatchObject({ capped: true, cancelled: false });
    expect(second).toMatchObject({ capped: true, cancelled: false });
  });

  it('matches the existing resolver across brace, extglob, globstar, leading-dot, and dotfile cases', async () => {
    for (const path of [
      'src/a.ts',
      'src/a.js',
      'src/a.test.ts',
      'src/components/a.ts',
      'src/components/b.ts',
      'src/components/c.ts',
      'src/components/.hidden.ts',
      'src/generated/skip.ts',
      'src/nested/value.ts',
      'src/nested/.secret.ts',
      '.config/tool.ts',
      '.cache/skip.ts',
      'node_modules/pkg/ignored.ts',
      'dist/ignored.ts',
      '.git/ignored.ts',
      'README.md',
    ]) {
      fixture(path);
    }
    const targets = [
      target(
        ['./src/**/*.[tj]s', 'src/components/@(a|b).ts', 'src/**/*.{ts,js}'],
        ['**/*.test.ts', 'src/components/b.ts'],
        'source',
      ),
      target(['src/**/.*.ts', './.config/**/*.ts'], [], 'hidden'),
    ];
    const globalExcludes = ['**/generated/**', '**/.cache/**', 'src/**/.secret.ts'];

    const bounded = await resolveTargetsBounded(targets, testDir, globalExcludes, {
      maxResults: 100,
    });
    const existing = resolveTargets(targets, testDir, globalExcludes);

    expect(bounded).toEqual({
      files: existing,
      capped: false,
      cancelled: false,
    });
  });

  it.each([
    {
      expected: ['foo'],
      include: ['foo/**'],
      name: 'a terminal globstar matches the statically resolved file at its prefix',
    },
    {
      expected: ['foo'],
      include: ['[f]oo/**'],
      name: 'a singleton character class remains a statically resolved prefix',
    },
    {
      expected: [],
      include: ['*/**'],
      name: 'a wildcard prefix does not match a regular file at that prefix',
    },
    {
      expected: [],
      include: ['f*/**'],
      name: 'a wildcard-suffixed prefix does not match a regular file at that prefix',
    },
    {
      expected: [],
      include: ['[af]*/**'],
      name: 'a character-class wildcard prefix does not match a regular file at that prefix',
    },
    {
      expected: [],
      include: ['@(foo)/**'],
      name: 'an extglob prefix does not match a regular file at that prefix',
    },
    {
      expected: [],
      include: ['!(bar)/**'],
      name: 'a negative extglob prefix does not match a regular file at that prefix',
    },
    {
      expected: ['bar', 'foo'],
      include: ['{foo/**,bar/**}'],
      name: 'brace alternatives ending in globstar match their file prefixes',
    },
    {
      expected: ['bar'],
      include: ['{foo.ts/,bar/**}'],
      name: 'a globstar alternative does not activate a sibling trailing-slash alternative',
    },
    {
      expected: [],
      include: ['foo.ts/'],
      name: 'a plain trailing slash remains directory-only',
    },
  ])('preserves glob 13 file slash-candidate parity: $name', async ({ expected, include }) => {
    for (const path of ['foo', 'bar', 'foo.ts']) fixture(path);
    const selectedTarget = target(include);

    const bounded = await resolveTargetsBounded([selectedTarget], testDir, [], {
      maxResults: 10,
    });
    const existing = resolveTargets([selectedTarget], testDir, []);

    expect(relativeFiles(bounded.files)).toEqual(expected);
    expect(bounded).toEqual({
      files: existing,
      capped: false,
      cancelled: false,
    });
  });

  it.each(['*/**', 'f*/**', '[af]*/**', '@(foo)/**', '!(bar)/**'])(
    'still matches descendants below a directory selected by magic prefix %s',
    async (include) => {
      fixture('foo/value.ts');
      fixture('bar/value.ts');
      fixture('a/value.ts');
      const selectedTarget = target([include]);

      const bounded = await resolveTargetsBounded([selectedTarget], testDir, [], {
        maxResults: 10,
      });
      const existing = resolveTargets([selectedTarget], testDir, []);

      expect(bounded).toEqual({
        files: existing,
        capped: false,
        cancelled: false,
      });
    },
  );

  it.each(['foo.ts/', 'foo.ts/**'])(
    'slash-tests target ignore pattern %s for files',
    async (exclude) => {
      fixture('foo.ts');
      fixture('bar.ts');
      const selectedTarget = target(['*.ts'], [exclude]);

      const bounded = await resolveTargetsBounded([selectedTarget], testDir, [], {
        maxResults: 10,
      });
      const existing = resolveTargets([selectedTarget], testDir, []);

      expect(relativeFiles(bounded.files)).toEqual(['bar.ts']);
      expect(bounded).toEqual({
        files: existing,
        capped: false,
        cancelled: false,
      });
    },
  );

  it('supports an absolute include that remains inside the project root', async () => {
    fixture('src/value.ts');
    fixture('other.ts');
    const include = `${join(testDir, 'src').replaceAll('\\', '/')}/**/*.ts`;
    const selectedTarget = target([include]);

    const bounded = await resolveTargetsBounded([selectedTarget], testDir, [], {
      maxResults: 10,
    });
    const existing = resolveTargets([selectedTarget], testDir, []);

    expect(relativeFiles(bounded.files)).toEqual(['src/value.ts']);
    expect(bounded).toEqual({
      files: existing,
      capped: false,
      cancelled: false,
    });
  });

  it('keeps common-ignore basename matching aligned with glob on the host platform', async () => {
    for (const directory of ['DIST', '.GIT', 'NODE_MODULES']) {
      fixture(`${directory}/value.ts`);
      fixture(`files/${directory}`);
    }
    const selectedTarget = target(['**/*.ts', 'files/*', 'files/.*']);

    const bounded = await resolveTargetsBounded([selectedTarget], testDir, [], {
      maxResults: 10,
    });
    const existing = resolveTargets([selectedTarget], testDir, []);
    // Case-sensitive hosts (Linux): common-ignore matches exact basenames only
    // (`node_modules`/`dist`/`.git`), so the UPPERCASE variants stay. Include
    // matching uses minimatch `dot: false`, so `**/*.ts` does not enter the
    // dotted `.GIT/` directory — only `files/.*` can surface `files/.GIT`.
    // Case-insensitive hosts (darwin/win32): those basenames collide with the
    // ignore set and nothing remains.
    const expected =
      platform() === 'darwin' || platform() === 'win32'
        ? []
        : [
            'DIST/value.ts',
            'NODE_MODULES/value.ts',
            'files/.GIT',
            'files/DIST',
            'files/NODE_MODULES',
          ];

    expect(relativeFiles(bounded.files)).toEqual(expected);
    expect(bounded).toEqual({
      files: existing,
      capped: false,
      cancelled: false,
    });
  });

  it('excludes exact common-ignore basenames for both regular files and directories', async () => {
    for (const name of ['node_modules', 'dist', '.git']) {
      fixture(`files/${name}`);
      fixture(`directories/${name}/value.ts`);
    }
    fixture('keep.ts');
    const selectedTarget = target([
      'files/{node_modules,dist,.git}',
      'directories/**/value.ts',
      'directories/.git/**/value.ts',
      'keep.ts',
    ]);

    const bounded = await resolveTargetsBounded([selectedTarget], testDir, [], {
      maxResults: 20,
    });
    const existing = resolveTargets([selectedTarget], testDir, []);

    expect(relativeFiles(bounded.files)).toEqual(['keep.ts']);
    expect(bounded).toEqual({
      files: existing,
      capped: false,
      cancelled: false,
    });
  });

  it('orders a classified DT_UNKNOWN directory by its slash-qualified path prefix', () => {
    const entries = [
      { kind: 'directory' as const, name: 'a' },
      { kind: 'file' as const, name: 'a!.ts' },
    ];

    expect([...entries].sort(compareTargetFilesystemEntries).map((entry) => entry.name)).toEqual([
      'a!.ts',
      'a',
    ]);
  });

  it('stops at the N+1 probe while traversal state remains within fixed bounds', async () => {
    for (let directory = 0; directory < 40; directory += 1) {
      for (let file = 0; file < 25; file += 1) {
        fixture(`src/${String(directory).padStart(2, '0')}/${String(file).padStart(2, '0')}.ts`);
      }
    }

    const resolved = await resolveTargetsBounded([target()], testDir, [], {
      maxResults: 3,
    });
    let offered = 0;
    const walk = await walkTargetFilesystem(testDir, () => {
      offered++;
      return offered < 4;
    });

    expect(relativeFiles(resolved.files)).toEqual(['src/00/00.ts', 'src/00/01.ts', 'src/00/02.ts']);
    expect(resolved).toMatchObject({ capped: true, cancelled: false });
    expect(walk.stoppedByVisitor).toBe(true);
    expect(walk.metrics.visitedFiles).toBe(4);
    expect(walk.metrics.visitedEntries).toBeLessThan(1041);
    expect(walk.metrics.peakDirectoryBatchEntries).toBeLessThanOrEqual(
      TARGET_WALK_MAX_ENTRIES_PER_DIRECTORY,
    );
    expect(walk.metrics.peakFrontierEntries).toBeLessThanOrEqual(TARGET_WALK_MAX_FRONTIER_ENTRIES);
    expect(walk.metrics.directoryReadBufferSize).toBe(TARGET_WALK_DIRECTORY_READ_BUFFER_SIZE);
  });

  it('discards an over-limit directory batch and reports traversal capping', async () => {
    for (let index = 0; index <= TARGET_WALK_MAX_ENTRIES_PER_DIRECTORY; index += 1) {
      fixture(`${String(index).padStart(5, '0')}.ts`);
    }
    const offered: string[] = [];

    const walk = await walkTargetFilesystem(testDir, ({ relativePath }) => {
      offered.push(relativePath);
    });
    const resolved = await resolveTargetsBounded([target(['**/*.ts'])], testDir, [], {
      maxResults: 10,
    });

    expect(walk).toMatchObject({
      capped: true,
      cancelled: false,
      stoppedByVisitor: false,
    });
    expect(walk.metrics.visitedEntries).toBe(TARGET_WALK_MAX_ENTRIES_PER_DIRECTORY);
    expect(walk.metrics.peakDirectoryBatchEntries).toBe(TARGET_WALK_MAX_ENTRIES_PER_DIRECTORY);
    expect(offered).toEqual([]);
    expect(resolved).toEqual({ files: [], capped: true, cancelled: false });
  });

  it('fails closed with capped evidence when the global depth ceiling is reached', async () => {
    const segments = Array.from({ length: TARGET_WALK_MAX_DEPTH + 1 }, (_, index) =>
      String(index).padStart(2, '0'),
    );
    fixture(`${segments.join('/')}/too-deep.ts`);

    const result = await resolveTargetsBounded([target(['**/*.ts'])], testDir, [], {
      maxResults: 10,
    });

    expect(result).toEqual({ files: [], capped: true, cancelled: false });
  });

  it('keeps completed earlier work but discards an interrupted directory batch', async () => {
    fixture('a.ts');
    for (let index = 0; index < 512; index += 1) {
      fixture(`z/${String(index).padStart(3, '0')}.ts`);
    }
    const controller = new AbortController();
    const offered: string[] = [];

    const walk = await walkTargetFilesystem(
      testDir,
      ({ relativePath }) => {
        offered.push(relativePath);
        if (relativePath === 'a.ts') setImmediate(() => controller.abort());
      },
      { signal: controller.signal },
    );

    expect(walk.cancelled).toBe(true);
    expect(walk.capped).toBe(false);
    expect(offered).toEqual(['a.ts']);
  });

  it('skips an entry that vanishes after its directory batch is sorted, without capping', async () => {
    fixture('a.ts');
    const later = fixture('b.ts');
    fixture('c.ts');
    const offered: string[] = [];

    const walk = await walkTargetFilesystem(testDir, ({ relativePath }) => {
      offered.push(relativePath);
      if (relativePath === 'a.ts') rmSync(later);
    });

    // b.ts vanished before it could be stat'd: it is skipped, not capped, and
    // the walk continues past it to c.ts rather than abandoning the rest of
    // the tree (a per-entry stat failure is not a resource-bound truncation).
    expect(walk).toMatchObject({ capped: false, cancelled: false });
    expect(offered).toEqual(['a.ts', 'c.ts']);
  });

  it('never follows directory symlinks and only returns contained file symlinks', async () => {
    if (platform() === 'win32') return;
    const outside = temporaryDirectory('opensip-target-outside-');
    const insideFile = fixture('src/real/value.ts');
    const outsideFile = fixture('outside.ts', outside);
    mkdirSync(join(testDir, 'src'), { recursive: true });
    symlinkSync(join(testDir, 'src/real'), join(testDir, 'src/linked-directory'), 'dir');
    symlinkSync(outside, join(testDir, 'src/escape-directory'), 'dir');
    symlinkSync(insideFile, join(testDir, 'src/linked-file.ts'), 'file');
    symlinkSync(outsideFile, join(testDir, 'src/escape-file.ts'), 'file');

    const result = await resolveTargetsBounded([target()], testDir, [], {
      maxResults: 20,
    });

    expect(relativeFiles(result.files)).toEqual(['src/linked-file.ts', 'src/real/value.ts']);
    expect(result).toMatchObject({ capped: false, cancelled: false });
  });

  it('marks a zero-result budget capped when the first matching file is probed', async () => {
    fixture('src/a.ts');

    const result = await resolveTargetsBounded([target()], testDir, [], {
      maxResults: 0,
    });

    expect(result).toEqual({ files: [], capped: true, cancelled: false });
  });

  it('does not open the filesystem for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await resolveTargetsBounded([target()], join(testDir, 'missing'), [], {
      maxResults: 1,
      signal: controller.signal,
    });

    expect(result).toEqual({ files: [], capped: false, cancelled: true });
  });

  it.each([-1, 1.5, Number.POSITIVE_INFINITY, MAX_BOUNDED_TARGET_RESULTS + 1])(
    'rejects invalid maxResults %s before enumeration',
    async (maxResults) => {
      await expect(
        resolveTargetsBounded([target()], join(testDir, 'missing'), [], {
          maxResults,
        }),
      ).rejects.toThrow(/maxResults/);
    },
  );

  it.each([
    {
      name: 'target count',
      targets: Array.from({ length: MAX_BOUNDED_TARGETS + 1 }, () => target()),
      globals: [],
      message: /Target count/,
    },
    {
      name: 'include count',
      targets: [target(Array.from({ length: MAX_BOUNDED_TARGET_INCLUDES + 1 }, () => '**/*.ts'))],
      globals: [],
      message: /include count/,
    },
    {
      name: 'exclude count',
      targets: [
        target(
          ['**/*.ts'],
          Array.from({ length: MAX_BOUNDED_TARGET_EXCLUDES + 1 }, () => '**/*.test.ts'),
        ),
      ],
      globals: [],
      message: /exclude count/,
    },
    {
      name: 'global exclude count',
      targets: [target()],
      globals: Array.from({ length: MAX_BOUNDED_GLOBAL_EXCLUDES + 1 }, () => '**/generated/**'),
      message: /Global exclude count/,
    },
    {
      name: 'total pattern count',
      targets: Array.from({ length: 3 }, (_, index) =>
        target(
          Array.from({ length: 128 }, () => '**/*.ts'),
          Array.from({ length: 64 }, () => '**/*.test.ts'),
          `target-${index}`,
        ),
      ),
      globals: [],
      message: /Total target pattern count/,
    },
    {
      name: 'pattern byte length',
      targets: [target(['x'.repeat(MAX_BOUNDED_PATTERN_BYTES + 1)])],
      globals: [],
      message: /bytes/,
    },
    {
      name: 'brace expansion count',
      targets: [target([`src/{1..${MAX_BOUNDED_BRACE_EXPANSIONS + 1}}.ts`])],
      globals: [],
      message: /braces/,
    },
    {
      name: 'brace-expanded parent path segment',
      targets: [target(['{src,../outside}/**/*.ts'])],
      globals: [],
      message: /parent path segments/,
    },
  ])(
    'rejects hostile $name before filesystem enumeration',
    async ({ targets, globals, message }) => {
      await expect(
        resolveTargetsBounded(targets, join(testDir, 'missing'), globals, {
          maxResults: 1,
        }),
      ).rejects.toThrow(message);
    },
  );

  it('rejects aggregate brace alternatives before matcher construction', async () => {
    const alternativesPerPattern = 64;
    const excludeCount =
      Math.floor(MAX_BOUNDED_TOTAL_EXPANDED_ALTERNATIVES / alternativesPerPattern / 2) + 1;
    const excludes = Array.from(
      { length: excludeCount },
      (_, index) => `generated-${String(index)}/{1..${String(alternativesPerPattern)}}.ts`,
    );

    await expect(
      resolveTargetsBounded([target(['**/*.ts'], excludes)], join(testDir, 'missing'), [], {
        maxResults: 1,
      }),
    ).rejects.toThrow(/Total expanded target alternatives/);
  });

  it('rejects aggregate expanded UTF-8 bytes before matcher construction', async () => {
    const suffix = '/value.ts';
    const maximumPattern = `${'x'.repeat(MAX_BOUNDED_PATTERN_BYTES - suffix.length)}${suffix}`;
    const saturatedTarget = target(
      Array.from({ length: MAX_BOUNDED_TARGET_INCLUDES }, () => maximumPattern),
      Array.from({ length: MAX_BOUNDED_TARGET_EXCLUDES }, () => maximumPattern),
    );
    expect(
      (MAX_BOUNDED_TARGET_INCLUDES + MAX_BOUNDED_TARGET_EXCLUDES * 2) *
        Buffer.byteLength(maximumPattern, 'utf8'),
    ).toBeLessThanOrEqual(MAX_BOUNDED_TOTAL_EXPANDED_BYTES);

    await expect(
      resolveTargetsBounded([saturatedTarget, saturatedTarget], join(testDir, 'missing'), [], {
        maxResults: 1,
      }),
    ).rejects.toThrow(/Total expanded target pattern bytes/);
  });
});

describe('resolveTargetMembershipsBounded', () => {
  it('preserves exact deterministic memberships in one shared target projection', async () => {
    for (const path of ['lib/value.ts', 'src/a.ts', 'src/a.test.ts', 'src/generated/drop.ts']) {
      fixture(path);
    }
    const source = target(['src/**/*.ts'], ['**/*.test.ts'], 'zeta');
    const allExceptLib = target(['**/*.ts'], ['lib/**'], 'alpha');
    const library = target(['lib/**/*.ts'], [], 'beta');

    const forward = await resolveTargetMembershipsBounded(
      [source, allExceptLib, library],
      testDir,
      ['**/generated/**'],
      { maxResults: 20, maxTargetsPerFile: 3 },
    );
    const reverse = await resolveTargetMembershipsBounded(
      [library, allExceptLib, source],
      testDir,
      ['**/generated/**'],
      { maxResults: 20, maxTargetsPerFile: 3 },
    );
    const expected = {
      memberships: [
        { filePath: join(testDir, 'lib/value.ts'), targetNames: ['beta'] },
        { filePath: join(testDir, 'src/a.test.ts'), targetNames: ['alpha'] },
        { filePath: join(testDir, 'src/a.ts'), targetNames: ['alpha', 'zeta'] },
      ],
      capped: false,
      membershipCapped: false,
      cancelled: false,
    };

    expect(forward).toEqual(expected);
    expect(reverse).toEqual(expected);
    expect(Object.isFrozen(forward)).toBe(true);
    expect(Object.isFrozen(forward.memberships)).toBe(true);
    expect(Object.isFrozen(forward.memberships[0]?.targetNames)).toBe(true);
  });

  it('reports independent file and per-file membership caps', async () => {
    fixture('a.ts');
    fixture('b.ts');
    const alpha = target(['*.ts'], [], 'alpha');
    const zeta = target(['*.ts'], [], 'zeta');

    const resolved = await resolveTargetMembershipsBounded([zeta, alpha], testDir, [], {
      maxResults: 1,
      maxTargetsPerFile: 1,
    });

    expect(resolved).toEqual({
      memberships: [{ filePath: join(testDir, 'a.ts'), targetNames: ['alpha'] }],
      capped: true,
      membershipCapped: true,
      cancelled: false,
    });
  });

  it('snapshots a hostile membership bound once', async () => {
    fixture('a.ts');
    const alpha = target(['*.ts'], [], 'alpha');
    const zeta = target(['*.ts'], [], 'zeta');
    let boundReads = 0;
    const options = Object.defineProperties(
      {},
      {
        maxResults: { enumerable: true, value: 1 },
        maxTargetsPerFile: {
          enumerable: true,
          get: () => {
            boundReads += 1;
            return boundReads === 1 ? 1 : MAX_BOUNDED_TARGETS;
          },
        },
      },
    ) as { readonly maxResults: number; readonly maxTargetsPerFile: number };

    const resolved = await resolveTargetMembershipsBounded([zeta, alpha], testDir, [], options);

    expect(resolved).toMatchObject({
      memberships: [{ targetNames: ['alpha'] }],
      membershipCapped: true,
    });
    expect(boundReads).toBe(1);
  });

  it('does not open the filesystem for an already-aborted membership walk', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      resolveTargetMembershipsBounded([target()], join(testDir, 'missing'), [], {
        maxResults: 1,
        maxTargetsPerFile: 1,
        signal: controller.signal,
      }),
    ).resolves.toEqual({
      memberships: [],
      capped: false,
      membershipCapped: false,
      cancelled: true,
    });
  });

  it.each([0, 1.5, Number.POSITIVE_INFINITY, MAX_BOUNDED_TARGETS + 1])(
    'rejects invalid maxTargetsPerFile %s before enumeration',
    async (maxTargetsPerFile) => {
      await expect(
        resolveTargetMembershipsBounded([target()], join(testDir, 'missing'), [], {
          maxResults: 1,
          maxTargetsPerFile,
        }),
      ).rejects.toThrow(/maxTargetsPerFile/);
    },
  );
});

describe('applyGlobalExcludesBounded', () => {
  it('does not admit candidates yielded only by an overridden array iterator', async () => {
    const injected = fixture('src/injected.ts');
    const candidates: string[] = [];
    Object.defineProperty(candidates, Symbol.iterator, {
      value: function* hostileIterator() {
        yield injected;
      },
    });

    const bounded = await applyGlobalExcludesBounded(candidates, testDir, [], {
      maxResults: 1,
    });

    expect(bounded).toEqual({ files: [], capped: false, cancelled: false });
  });

  it('preserves legacy matching and containment with deterministic deduplication', async () => {
    const outside = temporaryDirectory('opensip-global-filter-outside-');
    const keep = fixture('src/keep.ts');
    const hidden = fixture('.hidden/value.ts');
    const generated = fixture('generated/value.ts');
    const literal = fixture('#literal');
    const outsideFile = fixture('outside.ts', outside);
    const escape = join(testDir, 'escape.ts');
    if (platform() !== 'win32') symlinkSync(outsideFile, escape, 'file');
    const patterns = ['.hidden/**', '{dist,generated}/**', '#literal', '!src/**'];
    const candidates = [generated, keep, hidden, keep, literal, escape];

    const bounded = await applyGlobalExcludesBounded(candidates, testDir, patterns, {
      maxResults: 20,
    });
    const legacy = [...new Set(applyGlobalExcludes(candidates, testDir, patterns))].sort();

    expect(bounded).toEqual({ files: legacy, capped: false, cancelled: false });
    expect(bounded.files).toEqual([keep]);
  });

  it('retains only the deterministic prefix and probes N+1 for capping', async () => {
    const alpha = fixture('src/a.ts');
    const beta = fixture('src/b.ts');
    const gamma = fixture('src/c.ts');
    const candidates = [gamma, beta, alpha, beta];

    await expect(
      applyGlobalExcludesBounded(candidates, testDir, [], { maxResults: 0 }),
    ).resolves.toEqual({ files: [], capped: true, cancelled: false });
    await expect(
      applyGlobalExcludesBounded(candidates, testDir, [], { maxResults: 2 }),
    ).resolves.toEqual({
      files: [alpha, beta],
      capped: true,
      cancelled: false,
    });
    await expect(
      applyGlobalExcludesBounded(candidates, testDir, [], { maxResults: 3 }),
    ).resolves.toEqual({
      files: [alpha, beta, gamma],
      capped: false,
      cancelled: false,
    });
  });

  it('returns bounded cancellation before and during candidate filtering', async () => {
    const candidates = Array.from({ length: 300 }, (_, index) =>
      fixture(`src/${String(index).padStart(3, '0')}.ts`),
    );
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      applyGlobalExcludesBounded(candidates, testDir, [], {
        maxResults: candidates.length,
        signal: alreadyAborted.signal,
      }),
    ).resolves.toEqual({ files: [], capped: false, cancelled: true });

    const interrupted = new AbortController();
    setImmediate(() => interrupted.abort());
    const partial = await applyGlobalExcludesBounded(candidates, testDir, [], {
      maxResults: candidates.length,
      signal: interrupted.signal,
    });
    expect(partial.cancelled).toBe(true);
    expect(partial.capped).toBe(false);
    expect(partial.files.length).toBeGreaterThan(0);
    expect(partial.files.length).toBeLessThan(candidates.length);
  });

  it.each([
    {
      files: Array.from({ length: MAX_BOUNDED_GLOBAL_FILTER_INPUTS + 1 }, () => '/missing'),
      globals: [] as readonly string[],
      message: /candidate count/,
      name: 'candidate count',
    },
    {
      files: [`/${'x'.repeat(MAX_BOUNDED_GLOBAL_FILTER_PATH_BYTES + 1)}`],
      globals: [] as readonly string[],
      message: /candidate path/,
      name: 'candidate path bytes',
    },
    {
      files: ['/bad\npath'],
      globals: [] as readonly string[],
      message: /candidate path/,
      name: 'candidate path controls',
    },
    {
      files: [] as readonly string[],
      globals: Array.from({ length: MAX_BOUNDED_GLOBAL_EXCLUDES + 1 }, () => '**/generated/**'),
      message: /Global exclude count/,
      name: 'global exclude count',
    },
  ])('rejects hostile $name before filtering', async ({ files, globals, message }) => {
    await expect(
      applyGlobalExcludesBounded(files, join(testDir, 'missing'), globals, {
        maxResults: 1,
      }),
    ).rejects.toThrow(message);
  });
});
