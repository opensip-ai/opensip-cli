/**
 * Duplicate-detection parity + policy guard (ADR-0064).
 *
 * yagni and graph share ONE implementation: the detection algorithm + curation policy
 * live in `@opensip-cli/clone-detection` (`findDuplicateBodies`), and the body hash is
 * computed by the same `digestCanonicalBody(normalizeWhitespace(stripComments(slice)))`
 * pipeline both tools use (yagni: `build-ts-inventory.ts`; graph:
 * `graph-typescript/inventory-helpers/hash-body.ts`). This test pins yagni's extraction +
 * the shared policy on a fixture corpus that exercises every branch — the standing guard
 * against the 430-vs-0 (filter-divergence) regression class. The full both-binaries
 * cross-tool run on a real repo is Phase 5 validation (Task 5.2), where graph has the heap
 * to build a complete catalog.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  type CloneCandidate,
  digestCanonicalBody,
  findDuplicateBodies,
  isEligibleKind,
  normalizeWhitespace,
} from '@opensip-cli/clone-detection';
import { RunScope, runWithScope } from '@opensip-cli/core';
import { typescriptGraphAdapter } from '@opensip-cli/graph-typescript';
import { stripComments } from '@opensip-cli/lang-typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { duplicateBodyCandidateDetector } from '../detectors/duplicate-body-candidate.js';
import { buildTsInventory } from '../lib/build-ts-inventory.js';
import { readYagniMetadata } from '../scoring/confidence.js';

// A function whose normalized body is >= 200 chars (passes the per-instance floor).
const BIG = `export function summarize(items: readonly number[]): { total: number; max: number; count: number } {
  let total = 0;
  let max = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    total += item;
    if (item > max) { max = item; }
  }
  return { total, max, count: items.length };
}`;

// A function whose normalized body is between 80 and 200 chars (passes the cross-package
// floor of 80, fails the per-instance floor of 200).
const MEDIUM = `export function normalizeName(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  return trimmed.replace(/[^a-z0-9]+/g, '-');
}`;

// A function whose normalized body is < 80 chars (fails the cross-package floor).
const THIN = `export function noop(): void {
  return;
}`;

// An arrow function — excluded by kind on both tools (yagni emits only eligible kinds).
const ARROW = `export const handler = (x: number): number => {
  const doubled = x * 2;
  return doubled + 1;
};`;

const STATIC_BLOCK = `  static {
    const values = [11, 13, 17, 19, 23, 29, 31, 37];
    const total = values.reduce((sum, value) => sum + value, 0);
    const label = values.map((value) => String(value * total)).join(':');
    globalThis.__opensipStaticParity = { label, total, count: values.length };
  }`;

const LOOSE_UNIQUE = `export function looseOnly(value: number): number {
  const scaled = value * 3;
  return scaled + 7;
}`;

const NAMELESS_CHILD_UNIQUE = `export function namelessChildOnly(value: number): number {
  const shifted = value + 101;
  return shifted * 2;
}`;

const EMPTY_NAME_CHILD_UNIQUE = `export function emptyNameChildOnly(value: number): number {
  const shifted = value + 211;
  return shifted * 3;
}`;

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'yagni-parity-'));
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'Node16',
        moduleResolution: 'Node16',
        skipLibCheck: true,
      },
      include: ['**/*.ts', '**/*.tsx'],
    }),
  );
  const pkg = (name: string): string => {
    const dir = join(root, name);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@p/${name}` }));
    return dir;
  };
  const a = pkg('a');
  const b = pkg('b');
  const c = pkg('c');
  mkdirSync(join(root, 'loose'), { recursive: true });
  writeFileSync(join(root, 'loose', 'unique.ts'), LOOSE_UNIQUE);
  mkdirSync(join(root, 'parent', 'nameless'), { recursive: true });
  writeFileSync(join(root, 'parent', 'package.json'), JSON.stringify({ name: '@p/parent' }));
  writeFileSync(join(root, 'parent', 'nameless', 'package.json'), JSON.stringify({}));
  writeFileSync(join(root, 'parent', 'nameless', 'unique.ts'), NAMELESS_CHILD_UNIQUE);
  mkdirSync(join(root, 'parent', 'empty-name'), { recursive: true });
  writeFileSync(join(root, 'parent', 'empty-name', 'package.json'), JSON.stringify({ name: '' }));
  writeFileSync(join(root, 'parent', 'empty-name', 'unique.ts'), EMPTY_NAME_CHILD_UNIQUE);

  // MEDIUM duplicated across 3 packages → cross-package aggregate (3 occurrences).
  writeFileSync(join(a, 'src', 'u.ts'), MEDIUM);
  writeFileSync(join(b, 'src', 'u.ts'), MEDIUM);
  writeFileSync(join(c, 'src', 'u.ts'), MEDIUM);
  // …plus a copy in a TEST file → excluded by inTestFile (must NOT raise the count to 4).
  writeFileSync(join(a, 'src', 'u.test.ts'), MEDIUM);

  // BIG duplicated twice within ONE package → per-instance group (2 members).
  writeFileSync(join(a, 'src', 'big1.ts'), BIG);
  writeFileSync(join(a, 'src', 'big2.ts'), BIG);
  // Class static blocks are graph-emitted as '<static-init>' function-declarations and
  // must also be emitted by yagni. Duplicated twice within one package → per-instance group.
  writeFileSync(join(a, 'src', 'static1.ts'), `export class StaticOne {\n${STATIC_BLOCK}\n}\n`);
  writeFileSync(join(a, 'src', 'static2.ts'), `export class StaticTwo {\n${STATIC_BLOCK}\n}\n`);

  // THIN duplicated across 3 packages → excluded (below the 80-char cross-package floor).
  writeFileSync(join(a, 'src', 'thin.ts'), THIN);
  writeFileSync(join(b, 'src', 'thin.ts'), THIN);
  writeFileSync(join(c, 'src', 'thin.ts'), THIN);

  // ARROW duplicated across packages → excluded by kind (never emitted by yagni).
  writeFileSync(join(a, 'src', 'arr.ts'), ARROW);
  writeFileSync(join(b, 'src', 'arr.ts'), ARROW);
  // Graph's TS discovery excludes declarations and module-format TS files today; yagni's
  // walker must keep the same duplicate-detection source scope.
  writeFileSync(join(a, 'src', 'ambient.d.ts'), `declare class Ambient { constructor(); }\n`);
  writeFileSync(join(a, 'src', 'module.mts'), MEDIUM);
  writeFileSync(join(a, 'src', 'common.cts'), MEDIUM);

  // A class + default-export + an overload signature — exercises the method / constructor /
  // getter / setter / default-export classify branches and the body-less skip. Single
  // package, not duplicated, so it adds no group.
  writeFileSync(
    join(a, 'src', 'cls.ts'),
    `export class Widget {
  constructor(private readonly base: number) {}
  get value(): number { return this.base; }
  set value(v: number) { /* readonly demo */ void v; }
  compute(): number { return this.base * 2 + 1; }
}
export default function (): number { return 42; }
export function overload(x: number): number;
export function overload(x: string): string;
export function overload(x: unknown): unknown { return x; }
`,
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('yagni duplicate detection — extraction + shared policy parity', () => {
  it('matches graph-typescript eligible CloneCandidates and exact-duplicate findings', () => {
    const yagniCandidates = buildTsInventory(root).filter(isEligibleKind);
    const graphCandidates = graphEligibleCandidates(root);

    expect(candidateSignatures(yagniCandidates)).toEqual(candidateSignatures(graphCandidates));
    expect(duplicateFindingsSignature(yagniCandidates)).toEqual(
      duplicateFindingsSignature(graphCandidates),
    );
  });

  it('computes byte-identical bodyHash via the canonical pipeline graph uses', () => {
    const candidates = buildTsInventory(root);
    const medium = candidates.find((c) => c.simpleName === 'normalizeName');
    expect(medium).toBeDefined();
    // The exact pipeline graph-typescript's digestFunctionBody uses — same shared fns.
    const expected = digestCanonicalBody(normalizeWhitespace(stripComments(MEDIUM)));
    expect(medium?.bodyHash).toBe(expected.hash);
    expect(medium?.bodySize).toBe(expected.size);
    // All copies share one hash (so they group).
    const mediumHashes = new Set(
      candidates.filter((c) => c.simpleName === 'normalizeName').map((c) => c.bodyHash),
    );
    expect(mediumHashes.size).toBe(1);
  });

  it('applies the shared curation policy exactly (cross-package, test-exclusion, floors, kind)', () => {
    const candidates = buildTsInventory(root);
    const { aggregates, groups } = findDuplicateBodies(candidates);

    // Exactly ONE cross-package aggregate: MEDIUM across @p/a, @p/b, @p/c.
    expect(aggregates).toHaveLength(1);
    const agg = aggregates[0];
    expect(agg?.packages).toEqual(['@p/a', '@p/b', '@p/c']);
    // 3 occurrences — the test-file copy in @p/a is EXCLUDED (not 4).
    expect(agg?.occurrenceCount).toBe(3);

    // Exactly TWO per-instance groups: BIG twice and STATIC_BLOCK twice in @p/a.
    expect(groups).toHaveLength(2);
    const groupNames = groups.map((g) => g.members.map((m) => m.simpleName).sort()).sort();
    expect(groupNames).toEqual([
      ['<static-init>', '<static-init>'],
      ['summarize', 'summarize'],
    ]);

    // THIN (below floor) and ARROW (excluded kind) produce no finding.
    const allHashes = [...aggregates.map((a) => a.bodyHash), ...groups.map((g) => g.bodyHash)];
    const thinHash = digestCanonicalBody(normalizeWhitespace(stripComments(THIN))).hash;
    expect(allHashes).not.toContain(thinHash);
    expect(candidates.some((c) => c.kind === 'arrow')).toBe(false);
  });

  it('classifies class members + default export, and skips body-less overloads', () => {
    const candidates = buildTsInventory(root);
    const kinds = new Set(
      candidates.filter((c) => c.filePath.endsWith('cls.ts')).map((c) => c.kind),
    );
    expect(kinds).toEqual(
      new Set(['method', 'constructor', 'getter', 'setter', 'function-declaration']),
    );
    // The default-export function records the '<default>' name; the overload SIGNATURE
    // (body-less) is skipped — only the implementation is a candidate.
    const names = candidates.filter((c) => c.filePath.endsWith('cls.ts')).map((c) => c.simpleName);
    expect(names).toContain('<default>');
    expect(names).toContain('Widget');
    expect(names.filter((n) => n === 'overload')).toHaveLength(1);
  });

  it('the detector emits reduction findings with reduction metadata (aggregate + per-instance)', async () => {
    const result = await runWithScope(new RunScope(), () =>
      duplicateBodyCandidateDetector.run({
        cwd: root,
        config: {},
        graphCatalog: null,
        includeTests: false,
      }),
    );
    // 1 cross-package aggregate + 2 per-instance groups = 3 findings.
    expect(result.signals).toHaveLength(3);
    const metas = result.signals.map((s) => readYagniMetadata(s));
    expect(metas.every((m) => m?.reductionCategory === 'dedupe')).toBe(true);
    expect(metas.every((m) => m?.confidence === 'medium')).toBe(true);
    expect(metas.every((m) => (m?.locDelta?.netEstimate ?? -1) >= 0)).toBe(true);
    // The cross-package finding carries the 'cross-package' risk tag; the per-instance one does not.
    expect(metas.some((m) => m?.riskTags.includes('cross-package'))).toBe(true);
    expect(metas.some((m) => m?.riskTags.length === 0)).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

type GraphOccurrenceLike = Pick<
  CloneCandidate,
  | 'bodyHash'
  | 'bodySize'
  | 'kind'
  | 'inTestFile'
  | 'filePath'
  | 'line'
  | 'column'
  | 'endLine'
  | 'simpleName'
  | 'qualifiedName'
>;

function graphEligibleCandidates(projectRoot: string): CloneCandidate[] {
  const discovery = typescriptGraphAdapter.discoverFiles({ cwd: projectRoot });
  const parsed = typescriptGraphAdapter.parseProject({
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
    configPathAbs: discovery.configPathAbs,
    compilerOptions: discovery.compilerOptions,
    resolutionMode: 'exact',
  });
  expect(parsed.parseErrors).toEqual([]);
  const walked = typescriptGraphAdapter.walkProject({
    project: parsed.project,
    projectDirAbs: discovery.projectDirAbs,
    files: discovery.files,
  });
  expect(walked.parseErrors).toEqual([]);
  return Object.values(walked.occurrences)
    .flatMap((occs) => occs.map((occ) => graphOccurrenceToCandidate(projectRoot, occ)))
    .filter(isEligibleKind);
}

function graphOccurrenceToCandidate(projectRoot: string, occ: GraphOccurrenceLike): CloneCandidate {
  return {
    bodyHash: occ.bodyHash,
    kind: occ.kind,
    inTestFile: occ.inTestFile,
    filePath: occ.filePath,
    line: occ.line,
    column: occ.column,
    endLine: occ.endLine,
    simpleName: occ.simpleName,
    qualifiedName: occ.qualifiedName,
    ...(occ.bodySize === undefined ? {} : { bodySize: occ.bodySize }),
    package: packageFor(projectRoot, occ.filePath),
  };
}

function packageFor(projectRoot: string, projectRel: string): string {
  let dir = dirname(join(projectRoot, projectRel));
  while (dir.startsWith(projectRoot)) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown };
      if (typeof raw.name === 'string' && raw.name.length > 0) return raw.name;
    } catch {
      // Keep walking toward the project root.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const segment = projectRel.split('/')[0];
  return segment && segment !== projectRel ? segment : '<unknown>';
}

function candidateSignatures(candidates: readonly CloneCandidate[]): readonly string[] {
  return candidates
    .map((c) =>
      [
        c.bodyHash,
        String(c.bodySize ?? ''),
        c.kind,
        String(c.inTestFile),
        c.filePath,
        String(c.line),
        String(c.column),
        String(c.endLine),
        c.simpleName,
        c.qualifiedName,
        c.package ?? '',
      ].join('|'),
    )
    .sort();
}

function duplicateFindingsSignature(candidates: readonly CloneCandidate[]): {
  readonly aggregates: readonly string[];
  readonly groups: readonly string[];
} {
  const findings = findDuplicateBodies(candidates);
  return {
    aggregates: findings.aggregates
      .map(
        (a) =>
          `${a.bodyHash}|${a.packages.join(',')}|${String(a.occurrenceCount)}|${memberId(a.anchor)}`,
      )
      .sort(),
    groups: findings.groups
      .map((g) => `${g.bodyHash}|${g.members.map(memberId).sort().join(',')}`)
      .sort(),
  };
}

function memberId(candidate: CloneCandidate): string {
  return [
    candidate.qualifiedName,
    candidate.filePath,
    String(candidate.line),
    String(candidate.column),
    candidate.simpleName,
    candidate.package ?? '',
  ].join('@');
}
