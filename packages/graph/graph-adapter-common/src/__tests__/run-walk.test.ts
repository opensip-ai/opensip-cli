/**
 * Behavior tests for the shared `runWalk` driver.
 *
 * `runWalk` owns the `walkProject` skeleton: it allocates the three output
 * sinks, filters `input.files` to those actually present in the parsed
 * project, sorts them for I-1 determinism, runs the adapter's per-file
 * `walkFile` inside a try/catch, and folds any throw into a project-relative
 * `ParseError`. These tests assert each of those contracts with a fake
 * `walkFile` that records what it sees and pushes into the supplied sinks.
 */

import { describe, expect, it } from 'vitest';

import { buildNameIndex, record, runWalk } from '../walk.js';

import type { TreeSitterParsedFile, TreeSitterParsedProject } from '../parse.js';
import type {
  CallSiteRecord,
  DependencySiteRecord,
  FunctionOccurrence,
  WalkInput,
} from '@opensip-cli/graph';

// A parsed file is opaque to runWalk (only walkFile reads it), so a tagged
// stub suffices.
const mkFile = (tag: string): TreeSitterParsedFile => ({ tag }) as never;

const occ = (name: string, hash: string): FunctionOccurrence => ({
  bodyHash: hash,
  bodySize: 1,
  simpleName: name,
  qualifiedName: name,
  filePath: 'x',
  line: 1,
  column: 0,
  endLine: 1,
  kind: 'function-declaration',
  params: [],
  returnType: null,
  enclosingClass: null,
  decorators: [],
  visibility: 'private',
  inTestFile: false,
  definedInGenerated: false,
  calls: [],
});

const callSite = (ownerHash: string): CallSiteRecord => ({
  nodeRef: {},
  sourceFileRef: {},
  ownerHash,
  kind: 'call',
});

const depSite = (specifier: string, ownerHash: string): DependencySiteRecord => ({
  nodeRef: {},
  sourceFileRef: {},
  ownerHash,
  specifier,
  line: 1,
  column: 0,
});

type P = TreeSitterParsedProject;

describe('runWalk', () => {
  it('visits parsed files in sorted order, threading sinks + projectDir into walkFile', () => {
    const files = new Map<string, TreeSitterParsedFile>([
      ['/proj/b.go', mkFile('b')],
      ['/proj/a.go', mkFile('a')],
    ]);
    const input: WalkInput<P> = {
      project: { files },
      projectDirAbs: '/proj',
      // Deliberately out of order — runWalk must sort for determinism.
      files: ['/proj/b.go', '/proj/a.go'],
    };

    const seen: { path: string; projectDirAbs: string }[] = [];
    const out = runWalk<P>({
      input,
      walkFile: (absPath, file, projectDirAbs, sinks): void => {
        seen.push({ path: absPath, projectDirAbs });
        // Push one of each record kind so we can assert the sinks flow through.
        record(
          sinks.occurrences,
          occ(`fn-${(file as unknown as { tag: string }).tag}`, `h-${absPath}`),
        );
        sinks.callSites.push(callSite(`h-${absPath}`));
        sinks.dependencySites.push(depSite('./dep', `h-${absPath}`));
      },
    });

    // Sorted: a.go before b.go.
    expect(seen.map((s) => s.path)).toEqual(['/proj/a.go', '/proj/b.go']);
    expect(seen.every((s) => s.projectDirAbs === '/proj')).toBe(true);

    // Sinks flowed back out into WalkOutput.
    expect(out.occurrences['fn-a']?.[0]?.bodyHash).toBe('h-/proj/a.go');
    expect(out.occurrences['fn-b']?.[0]?.bodyHash).toBe('h-/proj/b.go');
    expect(out.callSites).toHaveLength(2);
    expect(out.dependencySites).toHaveLength(2);
    expect(out.parseErrors).toEqual([]);
  });

  it('filters out requested files that are not in the parsed project', () => {
    const files = new Map<string, TreeSitterParsedFile>([['/proj/a.go', mkFile('a')]]);
    const input: WalkInput<P> = {
      project: { files },
      projectDirAbs: '/proj',
      files: ['/proj/a.go', '/proj/missing.go'],
    };

    const visited: string[] = [];
    runWalk<P>({
      input,
      walkFile: (absPath): void => {
        visited.push(absPath);
      },
    });

    expect(visited).toEqual(['/proj/a.go']);
  });

  it('records a project-relative ParseError when walkFile throws an Error', () => {
    const files = new Map<string, TreeSitterParsedFile>([['/proj/pkg/bad.go', mkFile('bad')]]);
    const input: WalkInput<P> = {
      project: { files },
      projectDirAbs: '/proj',
      files: ['/proj/pkg/bad.go'],
    };

    const out = runWalk<P>({
      input,
      walkFile: (): void => {
        throw new Error('boom');
      },
    });

    expect(out.parseErrors).toHaveLength(1);
    expect(out.parseErrors[0]?.filePath).toBe('pkg/bad.go');
    expect(out.parseErrors[0]?.message).toBe('boom');
    // The walk still returns the (empty) sinks rather than aborting.
    expect(out.callSites).toEqual([]);
  });

  it('stringifies a non-Error throw value in the ParseError message', () => {
    const files = new Map<string, TreeSitterParsedFile>([['/proj/a.go', mkFile('a')]]);
    const input: WalkInput<P> = {
      project: { files },
      projectDirAbs: '/proj',
      files: ['/proj/a.go'],
    };

    const out = runWalk<P>({
      input,
      walkFile: (): void => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising the non-Error branch
        throw 'plain-string-failure';
      },
    });

    expect(out.parseErrors[0]?.message).toBe('plain-string-failure');
  });

  it('skips an entry whose project map claims `has` but returns no value from `get` (defensive guard)', () => {
    // A Map-like whose has/get disagree for one key — the exact inconsistency
    // the `if (!file) continue;` guard defends against (e.g. a concurrently
    // mutated map). The driver must skip it without throwing.
    const real = new Map<string, TreeSitterParsedFile>([['/proj/a.go', mkFile('a')]]);
    const inconsistent = {
      has: (k: string): boolean => k === '/proj/a.go' || k === '/proj/ghost.go',
      get: (k: string): TreeSitterParsedFile | undefined => real.get(k),
    } as never as ReadonlyMap<string, TreeSitterParsedFile>;

    const input: WalkInput<P> = {
      project: { files: inconsistent },
      projectDirAbs: '/proj',
      files: ['/proj/a.go', '/proj/ghost.go'],
    };

    const visited: string[] = [];
    const out = runWalk<P>({
      input,
      walkFile: (absPath): void => {
        visited.push(absPath);
      },
    });

    // ghost.go passed the `has` filter but `get` returned undefined → skipped.
    expect(visited).toEqual(['/proj/a.go']);
    expect(out.parseErrors).toEqual([]);
  });
});

describe('buildNameIndex — empty / sparse occurrence slots', () => {
  it('skips a name whose occurrence list is empty (no entry created)', () => {
    // A real name mapping to an empty array must NOT produce a map entry,
    // since there are no bodyHashes to resolve against.
    const functions: Record<string, FunctionOccurrence[]> = {
      foo: [occ('foo', 'h1')],
      bar: [], // empty → length 0 → not indexed
    };
    const idx = buildNameIndex(functions);
    expect(idx.get('foo')).toEqual(['h1']);
    expect(idx.has('bar')).toBe(false);
  });

  it('skips a falsy occurrence slot (defensive `!occs` guard)', () => {
    // A sparse/undefined slot (e.g. from a holey record) must be skipped
    // rather than throwing on iteration.
    const functions = {
      foo: [occ('foo', 'h1')],
      missing: undefined,
    } as unknown as Record<string, FunctionOccurrence[]>;
    const idx = buildNameIndex(functions);
    expect(idx.get('foo')).toEqual(['h1']);
    expect(idx.has('missing')).toBe(false);
  });
});
