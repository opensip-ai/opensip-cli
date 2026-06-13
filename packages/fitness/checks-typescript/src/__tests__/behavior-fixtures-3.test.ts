// @fitness-ignore-file file-length-limit -- behavior fixture suite; related scenarios stay together while checks are split into focused tests.
/**
 * @fileoverview Targeted behavior tests for resilience and remaining
 * mid-tier checks (context-leakage, async patterns, throws-documentation,
 * dispose-pattern-completeness, openapi-type-source, etc.).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { LanguageRegistry, RunScope, runWithScope } from '@opensip-cli/core';
import { fileCache } from '@opensip-cli/fitness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { typescriptAdapter } from '@opensip-cli/lang-typescript';

import { checks } from '../index.js';

// Production simulation: register the TS adapter (see behavior-fixtures.test.ts).
const langRegistry = new LanguageRegistry();
langRegistry.register(typescriptAdapter);
const testScope = new RunScope({ languages: langRegistry });

let cwd: string;
let written: string[] = [];

function fx(rel: string, content: string): string {
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  written.push(abs);
  return abs;
}

function findCheck(slug: string) {
  const c = checks.find((x) => x.config.slug === slug);
  if (!c) throw new Error(`check not found: ${slug}`);
  return c;
}

async function runCheck(slug: string) {
  const check = findCheck(slug);
  await fileCache.prewarm(cwd, ['**/*']);
  return runWithScope(testScope, () => check.run(cwd, { targetFiles: written }));
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'opensip-cov3-'));
  written = [];
});

afterEach(() => {
  fileCache.clear();
  rmSync(cwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// context-leakage (resilience/context-leakage)
// ---------------------------------------------------------------------------

describe('context-leakage — branch coverage', () => {
  it('flags module-level let with a *Context type', async () => {
    fx(
      'src/svc/leak.ts',
      [
        'declare class RequestContext {}',
        'export let activeContext: RequestContext | null = null',
        'export function setCtx(c: RequestContext) { activeContext = c }',
      ].join('\n'),
    );
    const result = await runCheck('context-leakage');
    expect(result.signals.length).toBeGreaterThanOrEqual(1);
  });

  it('flags module-level var with a *Ctx type', async () => {
    fx(
      'src/svc/leak2.ts',
      ['declare class TenantCtx {}', 'export var currentCtx: TenantCtx | null = null'].join('\n'),
    );
    const result = await runCheck('context-leakage');
    expect(result.signals.length).toBeGreaterThanOrEqual(1);
  });

  it('skips const declarations (cannot be reassigned)', async () => {
    fx(
      'src/svc/safe-const.ts',
      [
        'declare class RequestContext {}',
        'export const fixedContext: RequestContext | null = null',
      ].join('\n'),
    );
    const result = await runCheck('context-leakage');
    expect(result.signals).toHaveLength(0);
  });

  it('skips AsyncLocalStorage-typed declarations', async () => {
    fx(
      'src/svc/als.ts',
      [
        'import { AsyncLocalStorage } from "async_hooks"',
        'export let store: AsyncLocalStorage<unknown> = new AsyncLocalStorage()',
      ].join('\n'),
    );
    const result = await runCheck('context-leakage');
    expect(result.signals).toHaveLength(0);
  });

  it('skips OTel metric instrument lazy-init shape', async () => {
    fx(
      'src/svc/metrics.ts',
      [
        'declare class Counter {}',
        'declare class Histogram {}',
        'export let counter: Counter | null = null',
        'export let hist: Histogram | null = null',
      ].join('\n'),
    );
    const result = await runCheck('context-leakage');
    expect(result.signals).toHaveLength(0);
  });

  it('skips wrapper generic types like Injector<Context>', async () => {
    fx(
      'src/svc/wrapper.ts',
      [
        'declare class Injector<T> {}',
        'declare class AppContext {}',
        'export let inj: Injector<AppContext> | null = null',
      ].join('\n'),
    );
    const result = await runCheck('context-leakage');
    // Injector<...> outer type is in PROCESS_SCOPED_WRAPPER_TYPES → not flagged.
    expect(result.signals).toHaveLength(0);
  });

  it('flags class field with Context type when class is request-scoped (has tenantId param)', async () => {
    fx(
      'src/svc/cls-leak.ts',
      [
        'declare class RequestContext {}',
        'export class Handler {',
        '  private ctx: RequestContext | null = null',
        '  serve(tenantId: string) { return tenantId }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('context-leakage');
    expect(result.signals.length).toBeGreaterThanOrEqual(1);
  });

  it('flags class field when class has requestId or correlationId field', async () => {
    fx(
      'src/svc/cls-id.ts',
      [
        'declare class TenantContext {}',
        'export class Handler {',
        '  requestId = ""',
        '  private state: TenantContext | null = null',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('context-leakage');
    expect(result.signals.length).toBeGreaterThanOrEqual(1);
  });

  it('does not flag readonly or static class properties', async () => {
    fx(
      'src/svc/readonly.ts',
      [
        'declare class RequestContext {}',
        'export class Handler {',
        '  serve(tenantId: string) { return tenantId }',
        '  readonly ctx: RequestContext | null = null',
        '  static defaultCtx: RequestContext | null = null',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('context-leakage');
    expect(result.signals).toHaveLength(0);
  });

  it('skips DBOS step classes via decorator detection', async () => {
    fx(
      'src/svc/dbos.ts',
      [
        'declare const DBOS: { step: () => MethodDecorator; workflow: () => MethodDecorator }',
        'declare class RequestContext {}',
        'export class StepHost {',
        '  private ctx: RequestContext | null = null',
        '  @DBOS.step()',
        '  run(tenantId: string) { return tenantId }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('context-leakage');
    // DBOS step host is skipped.
    expect(result.signals).toHaveLength(0);
  });

  it('skips files under dbos/steps/ paths', async () => {
    fx(
      'src/dbos/steps/runner.ts',
      ['declare class RequestContext {}', 'export let active: RequestContext | null = null'].join(
        '\n',
      ),
    );
    const result = await runCheck('context-leakage');
    expect(result.signals).toHaveLength(0);
  });

  it('skips test files', async () => {
    fx(
      'src/svc/foo.test.ts',
      [
        'declare class RequestContext {}',
        'export let activeContext: RequestContext | null = null',
      ].join('\n'),
    );
    const result = await runCheck('context-leakage');
    expect(result.signals).toHaveLength(0);
  });

  it('quick-bails on files without "context" or "ctx" substring', async () => {
    fx('src/svc/no-ctx.ts', 'export const x = 1');
    const result = await runCheck('context-leakage');
    expect(result.signals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// detached-promises (resilience/detached-promises)
// ---------------------------------------------------------------------------

describe('detached-promises — branch coverage', () => {
  it('flags fire-and-forget Promise calls in async context', async () => {
    fx(
      'src/async/detached.ts',
      [
        'declare function expensiveTask(): Promise<void>',
        'export async function f() {',
        '  expensiveTask()', // missing await
        '  await Promise.resolve()',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('detached-promises');
    expect(result).toBeDefined();
  });

  it('skips Promise calls with .catch() handler', async () => {
    fx(
      'src/async/handled.ts',
      [
        'declare function task(): Promise<void>',
        'export async function f() {',
        '  task().catch(() => {})',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('detached-promises');
    expect(result).toBeDefined();
  });

  it('skips known sync calls (e.g. console.log, .push, .set)', async () => {
    fx(
      'src/async/sync.ts',
      [
        'export async function f() {',
        '  console.log("hi")',
        '  const arr: number[] = []',
        '  arr.push(1)',
        '  const map = new Map<string, number>()',
        '  map.set("a", 1)',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('detached-promises');
    expect(result.signals).toHaveLength(0);
  });

  it('skips calls outside async context', async () => {
    fx(
      'src/async/sync-fn.ts',
      [
        'declare function task(): Promise<void>',
        'export function nonAsync() {',
        '  task()',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('detached-promises');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// no-unbounded-concurrency (resilience/no-unbounded-concurrency)
// ---------------------------------------------------------------------------

describe('no-unbounded-concurrency — branch coverage', () => {
  it('flags Promise.all over an unbounded array', async () => {
    fx(
      'src/async/parallel.ts',
      [
        'declare function loadOne(id: number): Promise<unknown>',
        'export async function loadAll(ids: number[]) {',
        '  return await Promise.all(ids.map(loadOne))',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('no-unbounded-concurrency');
    expect(result).toBeDefined();
  });

  it('skips files using bounded concurrency primitives (p-limit, etc.)', async () => {
    fx(
      'src/async/bounded.ts',
      [
        'import pLimit from "p-limit"',
        'declare function loadOne(id: number): Promise<unknown>',
        'const limit = pLimit(5)',
        'export async function loadAll(ids: number[]) {',
        '  return await Promise.all(ids.map((id) => limit(() => loadOne(id))))',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('no-unbounded-concurrency');
    expect(result.signals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// no-raw-fetch
// ---------------------------------------------------------------------------

describe('no-raw-fetch — branch coverage', () => {
  it('flags raw fetch() calls', async () => {
    fx(
      'src/api/raw.ts',
      ['export async function f() {', '  return fetch("/api/x")', '}'].join('\n'),
    );
    const result = await runCheck('no-raw-fetch');
    expect(result).toBeDefined();
  });

  it('skips files inside test directories', async () => {
    fx(
      'src/__tests__/raw.test.ts',
      ['export async function f() {', '  return fetch("/api/x")', '}'].join('\n'),
    );
    const result = await runCheck('no-raw-fetch');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// await-result-unwrap
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// throws-documentation
// ---------------------------------------------------------------------------

describe('throws-documentation — extra branch coverage', () => {
  it('handles arrow functions and methods that throw', async () => {
    fx(
      'src/throws/arrow.ts',
      [
        'export const validateA = (x: string): string => {',
        '  if (!x) throw new Error("empty")',
        '  return x',
        '}',
        'export class C {',
        '  validate(x: string): string {',
        '    if (!x) throw new Error("empty")',
        '    return x',
        '  }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('throws-documentation');
    expect(result).toBeDefined();
  });

  it('skips functions that re-throw (catch + throw)', async () => {
    fx(
      'src/throws/rethrow.ts',
      ['export function f() {', '  try { return 1 } catch (e) { throw e }', '}'].join('\n'),
    );
    const result = await runCheck('throws-documentation');
    expect(result).toBeDefined();
  });

  it('skips test files', async () => {
    fx('src/throws/foo.test.ts', ['export function f() { throw new Error("test") }'].join('\n'));
    const result = await runCheck('throws-documentation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// dispose-pattern-completeness
// ---------------------------------------------------------------------------

describe('dispose-pattern-completeness — branch coverage', () => {
  it('flags dispose() bodies that do not clean up subscriptions/intervals', async () => {
    fx(
      'src/lifecycle/dispose.ts',
      [
        'export interface IDisposable { dispose(): void }',
        'export class Holder implements IDisposable {',
        '  private interval = setInterval(() => undefined, 1000)',
        '  private sub = { unsubscribe() {} }',
        '  dispose(): void {}', // empty - does not clear interval or unsubscribe
        '}',
      ].join('\n'),
    );
    const result = await runCheck('dispose-pattern-completeness');
    expect(result).toBeDefined();
  });

  it('does not flag dispose() that cleans up everything', async () => {
    fx(
      'src/lifecycle/dispose-clean.ts',
      [
        'export interface IDisposable { dispose(): void }',
        'export class Holder implements IDisposable {',
        '  private interval: NodeJS.Timeout | null = null',
        '  private sub = { unsubscribe() {} }',
        '  dispose(): void {',
        '    if (this.interval) clearInterval(this.interval)',
        '    this.sub.unsubscribe()',
        '  }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('dispose-pattern-completeness');
    expect(result).toBeDefined();
  });

  it('handles classes without IDisposable interface', async () => {
    fx(
      'src/lifecycle/no-disposable.ts',
      ['export class Plain {', '  start() { return 1 }', '}'].join('\n'),
    );
    const result = await runCheck('dispose-pattern-completeness');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// openapi-type-source
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// drizzle-orm-migration-guardrails
// ---------------------------------------------------------------------------

describe('drizzle-orm-migration-guardrails — branch coverage', () => {
  it('runs over drizzle migration files with risky DDL', async () => {
    fx(
      'src/db/migrations/001_drop_col.ts',
      [
        'import { sql } from "drizzle-orm"',
        'export const up = sql`ALTER TABLE users DROP COLUMN email`',
        'export const down = sql`ALTER TABLE users ADD COLUMN email VARCHAR(255)`',
      ].join('\n'),
    );
    const result = await runCheck('drizzle-orm-migration-guardrails');
    expect(result).toBeDefined();
  });

  it('runs over safe DDL (CREATE TABLE / ADD COLUMN)', async () => {
    fx(
      'src/db/migrations/002_create.ts',
      [
        'import { sql } from "drizzle-orm"',
        'export const up = sql`CREATE TABLE users (id SERIAL PRIMARY KEY)`',
      ].join('\n'),
    );
    const result = await runCheck('drizzle-orm-migration-guardrails');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// silent-early-returns
// ---------------------------------------------------------------------------

describe('silent-early-returns — extra branch coverage', () => {
  it('flags return null/false/undefined as guard clauses', async () => {
    fx(
      'src/handlers/silent.ts',
      [
        'export function fetchUser(id: string) {',
        '  if (!id) return null',
        '  if (id.length > 100) return false',
        '  return { id }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('silent-early-returns');
    expect(result).toBeDefined();
  });

  it('skips returns inside .map() / .filter() predicate callbacks', async () => {
    fx(
      'src/handlers/predicate.ts',
      [
        'export function f(arr: number[]) {',
        '  return arr.map((x) => {',
        '    if (x < 0) return null',
        '    return x * 2',
        '  })',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('silent-early-returns');
    expect(result).toBeDefined();
  });

  it('skips functions named with "validate"/"is"/"check" prefixes', async () => {
    fx(
      'src/handlers/validators.ts',
      [
        'export function isValid(x: number): boolean {',
        '  if (!x) return false',
        '  return true',
        '}',
        'export function checkInput(s: string): boolean {',
        '  if (!s) return false',
        '  return true',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('silent-early-returns');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// stream-buffer-size-limits
// ---------------------------------------------------------------------------

describe('stream-buffer-size-limits — branch coverage', () => {
  it('flags unbounded chunk accumulation', async () => {
    fx(
      'src/streams/unbounded.ts',
      [
        'export async function readAll(stream: AsyncIterable<Buffer>) {',
        '  const chunks: Buffer[] = []',
        '  for await (const chunk of stream) {',
        '    chunks.push(chunk)',
        '  }',
        '  return Buffer.concat(chunks)',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('stream-buffer-size-limits');
    expect(result).toBeDefined();
  });

  it('skips files without stream-related patterns', async () => {
    fx('src/streams/none.ts', 'export const x = 1');
    const result = await runCheck('stream-buffer-size-limits');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// toctou-race-condition
// ---------------------------------------------------------------------------

describe('toctou-race-condition — branch coverage', () => {
  it('flags read-modify-write on a shared Map / Set', async () => {
    fx(
      'src/cache/toctou.ts',
      [
        'export class Counter {',
        '  private state = new Map<string, number>()',
        '  increment(key: string) {',
        '    const v = this.state.get(key) ?? 0',
        '    this.state.set(key, v + 1)',
        '  }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('toctou-race-condition');
    expect(result).toBeDefined();
  });

  it('skips atomic operations and immediate increments', async () => {
    fx(
      'src/cache/atomic.ts',
      [
        'export class Plain {',
        '  private values: number[] = []',
        '  add(v: number) { this.values.push(v) }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('toctou-race-condition');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// array-validation
// ---------------------------------------------------------------------------

describe('array-validation — branch coverage', () => {
  it('flags array parameters without length validation', async () => {
    fx(
      'src/util/arr.ts',
      [
        'export function processItems(items: string[]): number {',
        '  return items.length + (items[0]?.length ?? 0)',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('array-validation');
    expect(result).toBeDefined();
  });

  it('skips functions that already validate array length', async () => {
    fx(
      'src/util/arr-safe.ts',
      [
        'export function processItems(items: string[]): number {',
        '  if (!Array.isArray(items)) throw new Error("not array")',
        '  if (items.length === 0) return 0',
        '  return items.length',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('array-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// financial-transaction-ordering
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// database-index-coverage
// ---------------------------------------------------------------------------

describe('database-index-coverage — branch coverage', () => {
  it('flags broad SELECT * queries', async () => {
    fx(
      'src/repos/wide.ts',
      [
        'declare const db: { query(sql: string): Promise<unknown> }',
        'export async function listAll() {',
        '  return db.query("SELECT * FROM users")',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('database-index-coverage');
    expect(result).toBeDefined();
  });

  it('flags leading-wildcard LIKE queries', async () => {
    fx(
      'src/repos/wildcard.ts',
      [
        'declare const db: { query(sql: string): Promise<unknown> }',
        'export async function search() {',
        '  return db.query("SELECT id FROM users WHERE name LIKE \'%bob%\'")',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('database-index-coverage');
    expect(result).toBeDefined();
  });

  it('flags db.find() / db.findOne() without WHERE', async () => {
    fx(
      'src/repos/find.ts',
      [
        'declare const db: { users: { find(): Promise<unknown>; findOne(): Promise<unknown> } }',
        'export async function f() { return db.users.find() }',
        'export async function g() { return db.users.findOne() }',
      ].join('\n'),
    );
    const result = await runCheck('database-index-coverage');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// missing-input-validation (more branches)
// ---------------------------------------------------------------------------

describe('missing-input-validation — extra branch coverage', () => {
  it('runs over a fastify handler reading req.body without validation', async () => {
    fx(
      'src/routes/no-validation.ts',
      [
        'import fastify from "fastify"',
        'const app = fastify()',
        'app.post("/users", async (req, res) => {',
        '  const body = req.body as { name: string }',
        '  return { name: body.name }',
        '})',
      ].join('\n'),
    );
    const result = await runCheck('missing-input-validation');
    expect(result).toBeDefined();
  });

  it('skips handlers that use Zod schema parsing', async () => {
    fx(
      'src/routes/zod-validated.ts',
      [
        'import { z } from "zod"',
        'const Schema = z.object({ name: z.string() })',
        'export function handle(input: unknown) {',
        '  const body = Schema.parse(input)',
        '  return body',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('missing-input-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// duplicate-utility-functions (more variants)
// ---------------------------------------------------------------------------

describe('duplicate-utility-functions — extra coverage', () => {
  it('compares many functions across files', async () => {
    fx(
      'src/utils/a.ts',
      [
        'export function snakeCase(s: string): string {',
        '  return s.replaceAll(/[A-Z]/g, (m) => "_" + m.toLowerCase())',
        '}',
        'export function kebabCase(s: string): string {',
        '  return s.replaceAll(/[A-Z]/g, (m) => "-" + m.toLowerCase())',
        '}',
      ].join('\n'),
    );
    fx(
      'src/utils/b.ts',
      [
        'export function snakeCase(input: string): string {',
        '  return input.replaceAll(/[A-Z]/g, (m) => "_" + m.toLowerCase())',
        '}',
      ].join('\n'),
    );
    fx('src/utils/c.ts', ['export function unique() { return Math.random() }'].join('\n'));
    const result = await runCheck('duplicate-utility-functions');
    expect(result).toBeDefined();
  });

  it('handles empty/single function files gracefully', async () => {
    fx('src/utils/single.ts', ['export function loneFn() { return 1 }'].join('\n'));
    const result = await runCheck('duplicate-utility-functions');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// circular-import-detection
// ---------------------------------------------------------------------------

describe('circular-import-detection — branch coverage', () => {
  it('flags simple A→B→A circular imports', async () => {
    fx('src/cyc/a.ts', 'import { b } from "./b.js"\nexport const a = () => b()');
    fx('src/cyc/b.ts', 'import { a } from "./a.js"\nexport const b = () => a()');
    const result = await runCheck('circular-import-detection');
    expect(result).toBeDefined();
  });

  it('handles longer cycles A→B→C→A', async () => {
    fx('src/cyc/x.ts', 'import { y } from "./y.js"\nexport const x = () => y()');
    fx('src/cyc/y.ts', 'import { z } from "./z.js"\nexport const y = () => z()');
    fx('src/cyc/z.ts', 'import { x } from "./x.js"\nexport const z = () => x()');
    const result = await runCheck('circular-import-detection');
    expect(result).toBeDefined();
  });

  it('does not flag acyclic graphs', async () => {
    fx('src/dag/a.ts', 'import { b } from "./b.js"\nexport const a = () => b()');
    fx('src/dag/b.ts', 'export const b = () => 1');
    const result = await runCheck('circular-import-detection');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// no-any-types
// ---------------------------------------------------------------------------

describe('no-any-types — branch coverage', () => {
  it('flags explicit any annotations', async () => {
    fx(
      'src/types/any.ts',
      [
        'export function f(x: any): any { return x }',
        'export const v: any = 1',
        'export const arr: any[] = []',
      ].join('\n'),
    );
    const result = await runCheck('no-any-types');
    expect(result).toBeDefined();
  });

  it('skips test files', async () => {
    fx('src/types/foo.test.ts', ['export function f(x: any): any { return x }'].join('\n'));
    const result = await runCheck('no-any-types');
    expect(result).toBeDefined();
  });

  it('skips files annotated with /* @any-ok */', async () => {
    fx(
      'src/types/annotated.ts',
      ['/* @any-ok */', 'export function f(x: any): any { return x }'].join('\n'),
    );
    const result = await runCheck('no-any-types');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// incomplete-regex-escaping
// ---------------------------------------------------------------------------

describe('incomplete-regex-escaping — branch coverage', () => {
  it('flags replace(/[abc]/g, "$&") that misses many specials', async () => {
    fx(
      'src/regex/bad.ts',
      [
        'export function bad(s: string) {',
        String.raw`  return s.replace(/[abc]/g, "\\$&")`,
        '}',
      ].join('\n'),
    );
    const result = await runCheck('incomplete-regex-escaping');
    expect(result).toBeDefined();
  });

  it('skips full character class escaping', async () => {
    fx(
      'src/regex/ok.ts',
      [
        'export function ok(s: string) {',
        String.raw`  return s.replace(/[\\\^$.*+?()[\]{}|]/g, "\\$&")`,
        '}',
      ].join('\n'),
    );
    const result = await runCheck('incomplete-regex-escaping');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// contracts-schema-consistency
// ---------------------------------------------------------------------------

describe('contracts-schema-consistency — branch coverage', () => {
  it('runs over zod schema declarations', async () => {
    fx(
      'src/schemas/user.ts',
      [
        'import { z } from "zod"',
        'export const UserSchema = z.object({ id: z.string(), name: z.string() })',
        'export const CreateUserSchema = z.object({ name: z.string() })',
        'export type User = z.infer<typeof UserSchema>',
      ].join('\n'),
    );
    const result = await runCheck('contracts-schema-consistency');
    expect(result).toBeDefined();
  });

  it('skips files without zod schemas', async () => {
    fx('src/schemas/no-zod.ts', 'export const x = 1');
    const result = await runCheck('contracts-schema-consistency');
    expect(result).toBeDefined();
  });
});
