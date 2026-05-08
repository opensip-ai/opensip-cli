import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { checks } from '../index.js';

describe('checks-builtin', () => {
  it('exports a non-empty array of checks', () => {
    expect(checks.length).toBeGreaterThan(50);
  });

  it('all checks have required fields', () => {
    for (const check of checks) {
      expect(check.config.id).toBeDefined();
      expect(check.config.slug).toBeDefined();
      expect(check.config.description).toBeDefined();
      expect(check.config.tags).toBeDefined();
      expect(check.config.tags.length).toBeGreaterThan(0);
    }
  });

  it('all check slugs are unique', () => {
    const slugs = checks.map((c) => c.config.slug);
    const duplicates = slugs.filter((s, i) => slugs.indexOf(s) !== i);
    expect(duplicates).toEqual([]);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('all check IDs are unique', () => {
    const ids = checks.map((c) => c.config.id);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(duplicates).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all checks have a valid analysisMode', () => {
    for (const check of checks) {
      expect(['analyze', 'analyzeAll', 'command']).toContain(check.config.analysisMode);
    }
  });

  it('all checks have a run function', () => {
    for (const check of checks) {
      expect(typeof check.run).toBe('function');
    }
  });
});

describe('no-console-log check', () => {
  const check = checks.find((c) => c.config.slug === 'no-console-log');

  let tmpDir: string;
  let violatingFile: string;
  let cleanFile: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-builtin-test-'));
    violatingFile = path.join(tmpDir, 'violating.ts');
    cleanFile = path.join(tmpDir, 'clean.ts');

    fs.writeFileSync(violatingFile, 'const x = 1;\nconsole.log("hello");\nconst y = 2;\n');
    fs.writeFileSync(cleanFile, 'const x = 1;\nconst y = 2;\n');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exists', () => {
    expect(check).toBeDefined();
  });

  it('detects console.log in a file', async () => {
    const result = await check!.run(tmpDir, { targetFiles: [violatingFile] });
    expect(result.errors + result.warnings).toBeGreaterThan(0);
    expect(result.passed).toBe(false);
  });

  it('passes clean files', async () => {
    const result = await check!.run(tmpDir, { targetFiles: [cleanFile] });
    expect(result.errors + result.warnings).toBe(0);
    expect(result.passed).toBe(true);
  });
});

// =============================================================================
// Refinement regression tests — added when triaging false positives in opensip.
// Each pair = one violating file + one clean file demonstrating the refinement.
// =============================================================================

describe('toctou-race-condition refinements', () => {
  const check = checks.find((c) => c.config.slug === 'toctou-race-condition');
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toctou-test-'));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips /routes/ paths', async () => {
    const file = path.join(tmpDir, 'routes', 'thing.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `export function handler(map: Map<string, string>) {
         const v = map.get('a');
         map.set('a', (v ?? '') + 'x');
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('skips /di/ paths', async () => {
    const file = path.join(tmpDir, 'di', 'graph.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `export function build(map: Map<string, unknown>) {
         const cur = map.get('a');
         map.set('a', cur ?? {});
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('flags project-specific paths (chain-walker) by default — moved to recipe config', async () => {
    // /chain-walker/ is opensip-specific; it is no longer a built-in default.
    // Without recipe augmentation, code there is analyzed normally.
    const file = path.join(tmpDir, 'chain-walker', 'walk.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Repository-style read-then-update on a *shared* receiver (not a
    // local Map). This is a real TOCTOU shape and must flag.
    fs.writeFileSync(
      file,
      `export async function walk(repo: { findOne(id: string): Promise<unknown>; save(v: unknown): Promise<void> }) {
         const v = await repo.findOne('a');
         await repo.save(v);
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBeGreaterThan(0);
  });

  it('skips project-specific paths when augmented via recipe config', async () => {
    const { setCurrentRecipeCheckConfig, clearCurrentRecipeCheckConfig } = await import(
      '@opensip-tools/core'
    );
    setCurrentRecipeCheckConfig({
      'toctou-race-condition': {
        additionalSafeTOCTOUPaths: ['/chain-walker/'],
      },
    });
    try {
      const file = path.join(tmpDir, 'chain-walker', 'walk-augmented.ts');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        `export async function walk(repo: { findOne(id: string): Promise<unknown>; save(v: unknown): Promise<void> }) {
           const v = await repo.findOne('a');
           await repo.save(v);
         }`,
      );
      const result = await check!.run(tmpDir, { targetFiles: [file] });
      expect(result.warnings).toBe(0);
    } finally {
      clearCurrentRecipeCheckConfig();
    }
  });

  it('skips local Map.get/set accumulator pattern', async () => {
    const file = path.join(tmpDir, 'accum.ts');
    fs.writeFileSync(
      file,
      `export function accum(name: string, counts: Map<string, number>) {
         counts.set(name, (counts.get(name) ?? 0) + 1);
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('skips local new Map() with grouping pattern', async () => {
    const file = path.join(tmpDir, 'group.ts');
    fs.writeFileSync(
      file,
      `export async function group(rows: ReadonlyArray<{ k: string; v: number }>) {
         const byKey = new Map<string, number[]>();
         for (const row of rows) {
           if (!byKey.has(row.k)) byKey.set(row.k, []);
           const bucket = byKey.get(row.k);
           if (bucket) bucket.push(row.v);
         }
         return byKey;
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('skips this.#cache get/set on a class field initialized as new Map()', async () => {
    const file = path.join(tmpDir, 'with-class-cache.ts');
    fs.writeFileSync(
      file,
      `export class Foo {
         readonly #cache = new Map<string, string>();
         async get(id: string): Promise<string> {
           const cached = this.#cache.get(id);
           if (cached) return cached;
           const fresh = await Promise.resolve('x');
           this.#cache.set(id, fresh);
           return fresh;
         }
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('skips read-only DB function building local Maps', async () => {
    const file = path.join(tmpDir, 'reader.ts');
    fs.writeFileSync(
      file,
      `export async function readOnly(db: { select(): { from(): Promise<Array<{ k: string; v: number }>> } }) {
         const rows = await db.select().from();
         const byKey = new Map<string, number[]>();
         for (const row of rows) {
           if (!byKey.has(row.k)) byKey.set(row.k, []);
           byKey.get(row.k)!.push(row.v);
         }
         return byKey;
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('skips single-statement atomic SQL UPDATE in tx.execute(sql`...`)', async () => {
    const file = path.join(tmpDir, 'atomic-sql.ts');
    fs.writeFileSync(
      file,
      `declare const sql: any;
       export async function bulkUpdate(tx: any, ticketIds: string[]) {
         const rows = await tx.select({ id: 'tickets.id' }).from('tickets');
         const byTicket = new Map<string, unknown>();
         for (const row of rows) byTicket.set((row as any).id, row);
         await tx.execute(sql\`UPDATE tickets SET v = 1 WHERE id = ANY($1)\`);
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('honors documented "single-threaded coalesce" comment as atomic', async () => {
    const file = path.join(tmpDir, 'cache.ts');
    fs.writeFileSync(
      file,
      `// single-threaded coalesce: Node event-loop guarantees no interleaving
       export function get(map: Map<string, string>) {
         const v = map.get('a');
         map.set('a', (v ?? '') + 'x');
         return v;
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });
});

describe('detached-promises refinements', () => {
  const check = checks.find((c) => c.config.slug === 'detached-promises');
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detached-test-'));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('flags project-specific helpers like attachDomainContext by default (no recipe config)', async () => {
    // attachDomainContext is opensip-specific — it is NOT a built-in default.
    // Without recipe config augmentation, it is treated as a potentially
    // unawaited call. opensip's recipe adds it via
    // `checks.config['detached-promises'].additionalSyncFunctions`.
    const file = path.join(tmpDir, 'a.ts');
    fs.writeFileSync(
      file,
      `async function handle() {
         attachDomainContext({ tenantId: 'a' });
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBeGreaterThan(0);
  });

  it('skips project-specific helpers when augmented via recipe config', async () => {
    const { setCurrentRecipeCheckConfig, clearCurrentRecipeCheckConfig } = await import(
      '@opensip-tools/core'
    );
    setCurrentRecipeCheckConfig({
      'detached-promises': {
        additionalSyncFunctions: ['attachDomainContext'],
      },
    });
    try {
      const file = path.join(tmpDir, 'a-augmented.ts');
      fs.writeFileSync(
        file,
        `async function handle() {
           attachDomainContext({ tenantId: 'a' });
         }`,
      );
      const result = await check!.run(tmpDir, { targetFiles: [file] });
      expect(result.warnings).toBe(0);
    } finally {
      clearCurrentRecipeCheckConfig();
    }
  });

  it('skips child.kill() (sync ChildProcess method)', async () => {
    const file = path.join(tmpDir, 'b.ts');
    fs.writeFileSync(
      file,
      `async function handle(child: any) {
         child.kill('SIGTERM');
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('skips init() / initialize-prefixed sync wiring', async () => {
    const file = path.join(tmpDir, 'c.ts');
    fs.writeFileSync(
      file,
      `async function boot(steps: any) {
         steps.init({ db: null });
         initSipPipelineSteps({});
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('skips upsertProfile (sync in-memory upsert helper)', async () => {
    const file = path.join(tmpDir, 'd.ts');
    fs.writeFileSync(
      file,
      `async function handle(store: any) {
         upsertProfile(store, 'a', { token: 'x' });
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('does not flag (await fn()).unwrap() chained sync method', async () => {
    const file = path.join(tmpDir, 'e.ts');
    fs.writeFileSync(
      file,
      `async function handle(git: any) {
         (await git.assertIntegrity('x')).unwrap();
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('still flags genuinely unawaited custom async call', async () => {
    const file = path.join(tmpDir, 'f.ts');
    fs.writeFileSync(
      file,
      `async function fetchUser(): Promise<string> { return 'x' }
       async function handle() {
         fetchUser();
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBeGreaterThan(0);
  });
});

describe('null-safety refinements', () => {
  const check = checks.find((c) => c.config.slug === 'null-safety');
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nullsafety-test-'));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not flag typed-inject .provideValue / .provideClass chain', async () => {
    const file = path.join(tmpDir, 'inject.ts');
    fs.writeFileSync(
      file,
      `declare const root: any;
       export function build() {
         return root
           .provideValue('a', 1)
           .provideClass('b', class {})
           .provideValue('c', 'x');
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('does not flag Drizzle .$type<T>() column builder', async () => {
    const file = path.join(tmpDir, 'column.ts');
    fs.writeFileSync(
      file,
      `declare function jsonb(name: string): any;
       export const col = jsonb('payload').$type<{ x: number }>().notNull();`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('skips files in **/di/fragments/ path', async () => {
    const file = path.join(tmpDir, 'svc', 'di', 'fragments', 'app.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `declare function getFoo(): { bar: string } | null;
       export const x = getFoo().bar;`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('skips **/schema/*.ts files', async () => {
    const file = path.join(tmpDir, 'pkg', 'schema', 'tables.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `declare function pgTable(n: string, c: any): any;
       declare function jsonb(n: string): any;
       export const t = pgTable('t', { c: jsonb('c').$type<{ x: number }>() });`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('still flags unguarded .x on a non-skipped file', async () => {
    const file = path.join(tmpDir, 'normal.ts');
    fs.writeFileSync(
      file,
      `declare function lookup(): { value: number } | null;
       export const v = lookup().value;`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBeGreaterThan(0);
  });

  it('flags project-specific paths (/dbos/schema) by default — moved to recipe config', async () => {
    const file = path.join(tmpDir, 'pkg', 'dbos', 'schema-tables.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `declare function lookup(): { value: number } | null;
       export const v = lookup().value;`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBeGreaterThan(0);
  });

  it('skips project-specific paths when augmented via recipe config', async () => {
    const { setCurrentRecipeCheckConfig, clearCurrentRecipeCheckConfig } = await import(
      '@opensip-tools/core'
    );
    setCurrentRecipeCheckConfig({
      'null-safety': {
        additionalSafeNullPaths: ['/dbos/schema'],
      },
    });
    try {
      const file = path.join(tmpDir, 'pkg', 'dbos', 'schema-tables-augmented.ts');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        `declare function lookup(): { value: number } | null;
         export const v = lookup().value;`,
      );
      const result = await check!.run(tmpDir, { targetFiles: [file] });
      expect(result.warnings).toBe(0);
    } finally {
      clearCurrentRecipeCheckConfig();
    }
  });
});

describe('throws-documentation refinements', () => {
  const check = checks.find((c) => c.config.slug === 'throws-documentation');
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'throws-doc-test-'));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not flag `throw sanitizedError(err)` rethrow helper', async () => {
    const file = path.join(tmpDir, 'sanitized.ts');
    fs.writeFileSync(
      file,
      `declare function sanitizedError(e: unknown): Error;
       export async function callApi() {
         try {
           return await fetch('x');
         } catch (err) {
           throw sanitizedError(err);
         }
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('does not flag `throw this.error` Result-pattern Failure rethrow', async () => {
    const file = path.join(tmpDir, 'failure.ts');
    fs.writeFileSync(
      file,
      `export class Failure<E> {
         constructor(public readonly error: E) {}
         unwrap(): never {
           throw this.error;
         }
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('does not flag `throw err.unwrapErr()` typed Result rethrow', async () => {
    const file = path.join(tmpDir, 'unwrap.ts');
    fs.writeFileSync(
      file,
      `declare function compute(): { unwrapErr(): Error };
       export function run() {
         try {
           return compute();
         } catch (err) {
           throw (err as { unwrapErr(): Error }).unwrapErr();
         }
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('does not flag throws of generic typed errors covered by built-in suffixes', async () => {
    // ValidationApiError ends with `ApiError`, NetworkError matches NetworkError —
    // both are kept as built-in defaults because they are generic enough that any
    // project may use them.
    const file = path.join(tmpDir, 'typed-generic.ts');
    fs.writeFileSync(
      file,
      `class ValidationApiError extends Error {}
       class GitNetworkError extends Error {}
       export function a() { throw new ValidationApiError(); }
       export function b() { throw new GitNetworkError(); }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('flags project-specific suffixes (CompositionError) by default — moved to recipe config', async () => {
    // CompositionError / CanonicalizationError are opensip-specific suffixes;
    // they are no longer built-in defaults. Without recipe config they are
    // treated as undocumented throws.
    const file = path.join(tmpDir, 'typed-project.ts');
    fs.writeFileSync(
      file,
      `class CanonicalizationError extends Error {}
       class CompositionError extends Error {}
       export function a() { throw new CanonicalizationError(); }
       export function b() { throw new CompositionError(); }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBeGreaterThan(0);
  });

  it('does not flag project-specific suffixes when augmented via recipe config', async () => {
    const { setCurrentRecipeCheckConfig, clearCurrentRecipeCheckConfig } = await import(
      '@opensip-tools/core'
    );
    setCurrentRecipeCheckConfig({
      'throws-documentation': {
        additionalSelfDocumentingSuffixes: ['CompositionError', 'CanonicalizationError'],
      },
    });
    try {
      const file = path.join(tmpDir, 'typed-project-augmented.ts');
      fs.writeFileSync(
        file,
        `class CanonicalizationError extends Error {}
         class CompositionError extends Error {}
         export function a() { throw new CanonicalizationError(); }
         export function b() { throw new CompositionError(); }`,
      );
      const result = await check!.run(tmpDir, { targetFiles: [file] });
      expect(result.warnings).toBe(0);
    } finally {
      clearCurrentRecipeCheckConfig();
    }
  });

  it('still flags genuinely undocumented `throw new Error(...)`', async () => {
    const file = path.join(tmpDir, 'generic.ts');
    fs.writeFileSync(
      file,
      `export function notDocumented() {
         throw new Error('boom');
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBeGreaterThan(0);
  });

  it('does not flag function whose throws are all rethrows of the caught variable', async () => {
    const file = path.join(tmpDir, 'mixed-rethrow.ts');
    fs.writeFileSync(
      file,
      `export async function run() {
         try {
           await Promise.resolve();
         } catch (caught) {
           if (caught instanceof Error) throw caught;
           throw caught;
         }
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });
});

describe('performance-anti-patterns refinements', () => {
  const check = checks.find((c) => c.config.slug === 'performance-anti-patterns');
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-anti-test-'));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not flag rest destructuring inside for loop as spread-in-loop', async () => {
    const file = path.join(tmpDir, 'destructure.ts');
    fs.writeFileSync(
      file,
      `interface Row { id: number; name: string; extra: string }
       export function transform(rows: Row[]) {
         const out: { id: number; rest: { name: string; extra: string } }[] = [];
         for (const r of rows) {
           const { id, ...rest } = r;
           out.push({ id, rest });
         }
         return out;
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    // No spread-in-loop warning should fire for destructuring rest.
    const spreadFindings = (result as unknown as { findings?: { message: string }[] }).findings ?? [];
    const spreadOnly = spreadFindings.filter((f) => f.message.includes('Spread operator'));
    expect(spreadOnly.length).toBe(0);
  });

  it('still flags actual spread-in-call inside for loop', async () => {
    const file = path.join(tmpDir, 'spread-call.ts');
    fs.writeFileSync(
      file,
      `export function build(items: number[][]) {
         let acc: number[] = [];
         for (const arr of items) {
           acc = [...acc, ...arr];
         }
         return acc;
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBeGreaterThan(0);
  });

  it('honours @sequential-ok pragma for legitimate sequential loops', async () => {
    const file = path.join(tmpDir, 'sequential-ok.ts');
    fs.writeFileSync(
      file,
      `// @sequential-ok: pagination drain — each iteration depends on prior offset
       declare function fetchPage(offset: number): Promise<unknown[]>;
       export async function drain() {
         let offset = 0;
         while (true) {
           const rows = await fetchPage(offset);
           if (rows.length === 0) break;
           offset += rows.length;
         }
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('does not flag retry/backoff loops with await delay()', async () => {
    const file = path.join(tmpDir, 'retry-loop.ts');
    fs.writeFileSync(
      file,
      `declare function attempt(): Promise<{ ok: boolean }>;
       declare function delay(ms: number): Promise<void>;
       export async function withRetries() {
         for (let i = 0; i < 3; i++) {
           const r = await attempt();
           if (r.ok) return r;
           await delay(100 * (i + 1));
         }
         throw new Error('exhausted');
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    // Retry-with-backoff loops are intentionally sequential — running
    // attempts in parallel would defeat the retry semantics.
    expect(result.warnings).toBe(0);
  });
});

describe('interface-implementation-consistency refinements', () => {
  const check = checks.find((c) => c.config.slug === 'interface-implementation-consistency');
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iface-impl-test-'));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not flag static factory methods as extra interface methods', async () => {
    const file = path.join(tmpDir, 'static-factory.ts');
    fs.writeFileSync(
      file,
      [
        'export interface KekProvider {',
        '  getKey(id: string): Promise<Buffer>;',
        '}',
        'export class EnvVarKekProvider implements KekProvider {',
        '  async getKey(id: string): Promise<Buffer> { return Buffer.from(id); }',
        '  static fromEnv(name: string): EnvVarKekProvider { return new EnvVarKekProvider(); }',
        '  static fromBase64(b64: string): EnvVarKekProvider { return new EnvVarKekProvider(); }',
        '}',
      ].join('\n'),
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('resolves generic interface inheritance — methods on the base interface are allowed', async () => {
    const file = path.join(tmpDir, 'generic-inherit.ts');
    fs.writeFileSync(
      file,
      [
        'export interface IAgentProviderResolver<out TProvider = unknown> {',
        '  get(id: string): TProvider;',
        '  has(id: string): boolean;',
        '  list(): TProvider[];',
        '}',
        'export interface IAgentProviderRegistry<TProvider = unknown>',
        '  extends IAgentProviderResolver<TProvider> {',
        '  register(provider: TProvider): void;',
        '}',
        'export class AgentProviderRegistry implements IAgentProviderRegistry<string> {',
        '  private readonly providers = new Map<string, string>();',
        '  get(id: string): string { return this.providers.get(id) ?? ""; }',
        '  has(id: string): boolean { return this.providers.has(id); }',
        '  list(): string[] { return [...this.providers.values()]; }',
        '  register(provider: string): void { this.providers.set(provider, provider); }',
        '}',
      ].join('\n'),
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('still flags genuinely extra public methods on a class implementing an interface', async () => {
    const file = path.join(tmpDir, 'extra-method.ts');
    fs.writeFileSync(
      file,
      [
        'export interface NarrowPort {',
        '  doThing(): void;',
        '}',
        'export class WideAdapter implements NarrowPort {',
        '  doThing(): void {}',
        '  undeclaredExtra(): number { return 42; }',
        '}',
      ].join('\n'),
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBeGreaterThan(0);
  });
});

describe('fastify-schema-coverage refinements', () => {
  const check = checks.find((c) => c.config.slug === 'fastify-schema-coverage');
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastify-schema-test-'));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not flag a POST route with no body schema if the handler does not read request.body', async () => {
    const file = path.join(tmpDir, 'bodyless.routes.ts');
    fs.writeFileSync(
      file,
      [
        "import { z } from 'zod';",
        'export const routes = async (fastify: any) => {',
        "  fastify.post('/tickets/:id/dispatch', {",
        '    schema: {',
        '      params: z.object({ id: z.string() }),',
        '      response: { 200: z.object({ success: z.boolean() }) },',
        '    },',
        '  }, async (request: any, reply: any) => {',
        '    const { id } = request.params;',
        "    return reply.send({ success: true, dispatched: id });",
        '  });',
        '};',
      ].join('\n'),
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    const findings = (result as unknown as { signals?: { metadata?: { type?: string } }[] }).signals ?? [];
    const bodySchemaFindings = findings.filter((f) => f.metadata?.type === 'missing-body-schema');
    expect(bodySchemaFindings.length).toBe(0);
  });

  it('still flags a POST route with no body schema when the handler reads request.body', async () => {
    const file = path.join(tmpDir, 'body-reader.routes.ts');
    fs.writeFileSync(
      file,
      [
        "import { z } from 'zod';",
        'export const routes = async (fastify: any) => {',
        "  fastify.post('/items', {",
        '    schema: {',
        '      response: { 200: z.object({ ok: z.boolean() }) },',
        '    },',
        '  }, async (request: any, reply: any) => {',
        '    const body = request.body as { name: string };',
        "    return reply.send({ ok: true, name: body.name });",
        '  });',
        '};',
      ].join('\n'),
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    const findings = (result as unknown as { signals?: { metadata?: { type?: string } }[] }).signals ?? [];
    const bodySchemaFindings = findings.filter((f) => f.metadata?.type === 'missing-body-schema');
    expect(bodySchemaFindings.length).toBeGreaterThan(0);
  });
});

describe('context-leakage AST refinements', () => {
  const check = checks.find((c) => c.config.slug === 'context-leakage');
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-leakage-test-'));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('flags module-level `let activeContext: RequestContext | null = null`', async () => {
    const file = path.join(tmpDir, 'leak-module.ts');
    fs.writeFileSync(
      file,
      [
        'interface RequestContext { tenantId: string }',
        'let activeContext: RequestContext | null = null;',
        'export function setCtx(c: RequestContext) { activeContext = c; }',
      ].join('\n'),
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBeGreaterThan(0);
  });

  it('flags class field `private context: RequestContext` on a request-scoped class', async () => {
    const file = path.join(tmpDir, 'leak-class.ts');
    fs.writeFileSync(
      file,
      [
        'interface RequestContext { foo: string }',
        'export class RequestHandler {',
        '  private context!: RequestContext;',
        '  async handle(tenantId: string): Promise<void> {',
        '    void tenantId; void this.context;',
        '  }',
        '}',
      ].join('\n'),
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBeGreaterThan(0);
  });

  it('does NOT flag module-level `let counter: Counter | null = null` (OTel lazy init)', async () => {
    const file = path.join(tmpDir, 'metric.ts');
    fs.writeFileSync(
      file,
      [
        'declare type Counter = unknown;',
        'declare type Histogram = unknown;',
        'let agentContextChars: Histogram | null = null;',
        'let agentContextWindowed: Counter | null = null;',
        'export function ensure() { agentContextChars = {} as Histogram; void agentContextWindowed; }',
      ].join('\n'),
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('does NOT flag class field whose type is `SyncStrategy<InitialSyncContext>` (type-only generic arg)', async () => {
    const file = path.join(tmpDir, 'sync-strategy.ts');
    fs.writeFileSync(
      file,
      [
        'declare type SyncStrategy<T> = { apply(): T };',
        'declare type InitialSyncContext = { kind: "initial" };',
        'export class BoundInitialStrategy {',
        '  private inner!: SyncStrategy<InitialSyncContext>;',
        '  // Class is request-scoped enough to fail naive class-field detection.',
        '  async handle(tenantId: string): Promise<void> { void tenantId; void this.inner; }',
        '}',
      ].join('\n'),
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('does NOT flag method-parameter type `(ctx: SomeContext) => …`', async () => {
    const file = path.join(tmpDir, 'method-param.ts');
    fs.writeFileSync(
      file,
      [
        'interface SomeContext { foo: string }',
        'export class Strategy {',
        '  async handle(tenantId: string, ctx: SomeContext): Promise<void> { void tenantId; void ctx; }',
        '}',
      ].join('\n'),
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('does NOT flag function-local `let ctx = …`', async () => {
    const file = path.join(tmpDir, 'local-let.ts');
    fs.writeFileSync(
      file,
      [
        'export function run() {',
        '  let ctx: { x: number } | null = null;',
        '  ctx = { x: 1 };',
        '  return ctx;',
        '}',
      ].join('\n'),
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('does NOT flag DBOS step `static ctx: SharedPipelineContext` (skip-by-path)', async () => {
    const file = path.join(tmpDir, 'pkg', 'sip', 'src', 'dbos', 'steps', 'review.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        'interface SharedPipelineContext { foo: string }',
        'export class ReviewSteps {',
        '  static ctx!: SharedPipelineContext;',
        '  static init(ctx: SharedPipelineContext) { ReviewSteps.ctx = ctx; }',
        '}',
      ].join('\n'),
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('does NOT flag DBOS step host (decorator-based detection, outside skip path)', async () => {
    const file = path.join(tmpDir, 'step-decorated.ts');
    fs.writeFileSync(
      file,
      [
        'declare const DBOS: { step: () => MethodDecorator };',
        'interface SharedPipelineContext { foo: string }',
        'export class FixSteps {',
        '  static ctx!: SharedPipelineContext;',
        '  @DBOS.step()',
        '  static async run(tenantId: string): Promise<void> { void tenantId; }',
        '}',
      ].join('\n'),
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });

  it('does NOT flag AsyncLocalStorage-typed declarations', async () => {
    const file = path.join(tmpDir, 'als.ts');
    fs.writeFileSync(
      file,
      [
        'declare class AsyncLocalStorage<T> { run(s: T, fn: () => void): void }',
        'interface RequestContext { id: string }',
        'export const requestContextStore = new AsyncLocalStorage<RequestContext>();',
        'export let backupStore: AsyncLocalStorage<RequestContext> | null = null;',
      ].join('\n'),
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
  });
});

// =============================================================================
// circular-import-detection — Phase 3 of architecture-gate-capability plan
// =============================================================================

describe('circular-import-detection', () => {
  const check = checks.find((c) => c.config.slug === 'circular-import-detection');
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'circular-import-test-'));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exists', () => {
    expect(check).toBeDefined();
  });

  it('passes a project with no cycles', async () => {
    const a = path.join(tmpDir, 'no-cycle-a.ts');
    const b = path.join(tmpDir, 'no-cycle-b.ts');
    fs.writeFileSync(a, `import {} from './no-cycle-b'`);
    fs.writeFileSync(b, `export const x = 1`);
    const result = await check!.run(tmpDir, { targetFiles: [a, b] });
    expect(result.errors).toBe(0);
    expect(result.passed).toBe(true);
  });

  it('detects a 2-file cycle', async () => {
    const a = path.join(tmpDir, 'cycle-a.ts');
    const b = path.join(tmpDir, 'cycle-b.ts');
    fs.writeFileSync(a, `import type {} from './cycle-b'`);
    fs.writeFileSync(b, `import type {} from './cycle-a'`);
    const result = await check!.run(tmpDir, { targetFiles: [a, b] });
    expect(result.errors).toBeGreaterThan(0);
    expect(result.passed).toBe(false);
  });

  it('detects a 3-file cycle', async () => {
    const a = path.join(tmpDir, 'tri-a.ts');
    const b = path.join(tmpDir, 'tri-b.ts');
    const c = path.join(tmpDir, 'tri-c.ts');
    fs.writeFileSync(a, `import type {} from './tri-b'`);
    fs.writeFileSync(b, `import type {} from './tri-c'`);
    fs.writeFileSync(c, `import type {} from './tri-a'`);
    const result = await check!.run(tmpDir, { targetFiles: [a, b, c] });
    expect(result.errors).toBe(1); // one cycle, one violation
  });
});

// =============================================================================
// module-coupling-fan-out — Phase 4 of architecture-gate-capability plan
// =============================================================================

describe('module-coupling-fan-out', () => {
  const check = checks.find((c) => c.config.slug === 'module-coupling-fan-out');
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fan-out-test-'));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exists', () => {
    expect(check).toBeDefined();
  });

  it('passes files with low fan-out (≤ 15)', async () => {
    // 5 leaf files + 1 importer that imports 5 of them — well under threshold.
    const leaves = Array.from({ length: 5 }, (_, i) => path.join(tmpDir, `leaf-low-${i}.ts`));
    leaves.forEach((p, i) => fs.writeFileSync(p, `export const x${i} = ${i}`));
    const importer = path.join(tmpDir, 'low-fan.ts');
    fs.writeFileSync(
      importer,
      leaves.map((p) => `import {} from './${path.basename(p, '.ts')}'`).join('\n'),
    );
    const result = await check!.run(tmpDir, { targetFiles: [importer, ...leaves] });
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(0);
  });

  it('warns at fan-out > 15 (warning threshold)', async () => {
    // 20 leaves → 20-edge fan-out → warning
    const leaves = Array.from({ length: 20 }, (_, i) => path.join(tmpDir, `leaf-warn-${i}.ts`));
    leaves.forEach((p, i) => fs.writeFileSync(p, `export const x${i} = ${i}`));
    const importer = path.join(tmpDir, 'warn-fan.ts');
    fs.writeFileSync(
      importer,
      leaves.map((p) => `import {} from './${path.basename(p, '.ts')}'`).join('\n'),
    );
    const result = await check!.run(tmpDir, { targetFiles: [importer, ...leaves] });
    expect(result.warnings).toBeGreaterThan(0);
    expect(result.errors).toBe(0);
  });

  it('errors at fan-out > 30 (error threshold)', async () => {
    // 35 leaves → 35-edge fan-out → error
    const leaves = Array.from({ length: 35 }, (_, i) => path.join(tmpDir, `leaf-err-${i}.ts`));
    leaves.forEach((p, i) => fs.writeFileSync(p, `export const x${i} = ${i}`));
    const importer = path.join(tmpDir, 'err-fan.ts');
    fs.writeFileSync(
      importer,
      leaves.map((p) => `import {} from './${path.basename(p, '.ts')}'`).join('\n'),
    );
    const result = await check!.run(tmpDir, { targetFiles: [importer, ...leaves] });
    expect(result.errors).toBeGreaterThan(0);
  });
});
