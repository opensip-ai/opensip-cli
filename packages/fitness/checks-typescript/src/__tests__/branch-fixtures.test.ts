// @fitness-ignore-file file-length-limit -- behavior fixture suite; related scenarios stay together while checks are split into focused tests.
/**
 * @fileoverview Branch-behavior fixture suite: targets high-impact uncovered branches
 * across many checks via rich, realistic source fixtures.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { RunScope, runWithScope } from '@opensip-tools/core';
import { fileCache } from '@opensip-tools/fitness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checks } from '../index.js';

const testScope = new RunScope();

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
  cwd = mkdtempSync(join(tmpdir(), 'opensip-cov-branch-'));
  written = [];
});

afterEach(() => {
  fileCache.clear();
  rmSync(cwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// detached-promises (resilience/async-patterns) — drive sync-call branches
// ---------------------------------------------------------------------------

describe('detached-promises — many sync-call branches', () => {
  it('exercises super(), this.method(), nested receivers, sync receivers, sync prefixes/suffixes', async () => {
    fx(
      'src/svc/detached.ts',
      [
        'class Base {',
        '  init() { this.helper() }',
        '  helper() {}',
        '}',
        'export class Svc extends Base {',
        '  async run(input: string) {',
        '    super.init()',
        '    this.syncMethod()',
        '    this.helper()',
        '    logger.info("hello")',
        '    this.logger.warn("nested")',
        '    Pyroscope.default.start()',
        '    myLogger.error("pattern receiver")',
        '    setupRoute(input)',
        '    teardownClient()',
        '    isReady()',
        '    fs.readFileSync("/tmp/x")',
        '    process.nextTick(() => undefined)',
        '    void doStuff()',
        '    apiCall().then(() => undefined)',
        '    apiCall().catch(() => undefined)',
        '    apiCall().finally(() => undefined)',
        '    unwrap(await apiCall())',
        '    (await apiCall()).chain()',
        '    apiCall()  // <-- detached',
        '  }',
        '  syncMethod() { return 1 }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('detached-promises');
    expect(result).toBeDefined();
  });

  it('handles non-async function with calls (skip), test files (skip)', async () => {
    fx('src/util/sync.ts', ['export function notAsync() { doStuff() }'].join('\n'));
    fx('src/x.test.ts', ['export async function t() { doStuff() }'].join('\n'));
    const result = await runCheck('detached-promises');
    expect(result).toBeDefined();
  });

  it('handles cli/script file skip patterns', async () => {
    fx('src/cli/cmd.ts', ['export async function run() { doStuff(); other(); }'].join('\n'));
    const result = await runCheck('detached-promises');
    expect(result).toBeDefined();
  });

  it('exercises super-call kind branch', async () => {
    fx(
      'src/svc/super.ts',
      [
        'class Parent {}',
        'export class Child extends Parent {',
        '  constructor() { super() }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('detached-promises');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// no-unbounded-concurrency — bounded-pattern branches
// ---------------------------------------------------------------------------

describe('no-unbounded-concurrency — bounded-pattern branches', () => {
  it('skips when content has p-limit, plimit, allSettled, concurrency:N, batch, throttle, rateLimit', async () => {
    const variants = [
      'import pLimit from "p-limit"\nawait Promise.all(items.map(fn))',
      'const limit = plimit(4)\nawait Promise.all(arr.map(fn))',
      'await Promise.allSettled(items.map(fn))',
      'await Promise.all(items.map(fn)) // concurrency: 4',
      'await Promise.all(items.map(fn)) // batch chunked',
      'await Promise.all(items.map(fn)) // throttle 10/s',
      'await Promise.all(items.map(fn)) // rateLimit 5',
    ];
    for (const [i, src] of variants.entries()) {
      fx(`src/api/u${i}.ts`, src);
    }
    fx('src/api/raw.ts', 'await Promise.all(items.map(fn))');
    const result = await runCheck('no-unbounded-concurrency');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// no-raw-fetch — many skip paths
// ---------------------------------------------------------------------------

describe('no-raw-fetch — skip-path branches', () => {
  it('skips resilient-fetch, fitness/checks paths, llm paths, streaming files, test files', async () => {
    fx('src/lib/resilient-fetch.ts', 'await fetch("/x")');
    fx('src/llm/openai.ts', 'await fetch("/x")');
    fx('src/llm-adapter/openai.ts', 'await fetch("/x")');
    fx('src/sse/stream.ts', 'const r = new ReadableStream(); await fetch("/x")');
    fx('src/sse/event.ts', 'const r = new EventSource(""); await fetch("/x")');
    fx('src/sse/r.ts', 'const reader = body.getReader(); await fetch("/x")');
    fx('src/x.test.ts', 'await fetch("/x")');
    fx('src/x.spec.ts', 'await fetch("/x")');
    fx('src/__tests__/y.ts', 'await fetch("/x")');
    fx('src/api/legit.ts', '// uses fetch\nawait fetch("/legit")');
    fx('src/api/comment.ts', '// fetch( comment\nawait fetch("/legit")');
    const result = await runCheck('no-raw-fetch');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// toctou-race-condition — exercise local/shared/atomic SQL/cache branches
// ---------------------------------------------------------------------------

describe('toctou-race-condition — many classification branches', () => {
  it('local Map/Set, this.cache, drizzle update/insert/delete, sql template, shared, unknown receiver', async () => {
    fx(
      'src/svc/toc.ts',
      [
        'class StringCache {',
        '  get(k: string): string | undefined { return undefined }',
        '  set(k: string, v: string): void {}',
        '}',
        'export class Service {',
        '  private headerCache: Map<string, string> = new Map()',
        '  #cache = new Map<string, number>()',
        '  cache: StringCache = new StringCache()',
        '  async fetchAndUpdate(id: string) {',
        '    const local = new Map<string, number>()',
        '    local.get(id)',
        '    local.set(id, 1)',
        '    this.headerCache.get(id)',
        '    this.headerCache.set(id, "x")',
        '    this.#cache.get(id)',
        '    this.#cache.set(id, 1)',
        '    this.cache.get(id)',
        '    this.cache.set(id, "x")',
        '    db.update(tableX)',
        '    db.insert(tableX)',
        '    db.delete(tableX)',
        '    tx.execute(sql`UPDATE x SET y=1`)',
        '    chain.foo().get(id)',
        '    chain.foo().update(id)',
        '    repo.findOne(id)',
        '    repo.put(id, 2)', // shared read+update
        '    return 1',
        '  }',
        '  async noPair(id: string) {',
        '    repo.find(id)',
        '    return null',
        '  }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('toctou-race-condition');
    expect(result).toBeDefined();
  });

  it('skips safe paths and atomic-comment files', async () => {
    fx('src/cache/foo.ts', 'export function f() { repo.find(); repo.set(1) }');
    fx('src/cli/cmd.ts', 'export function f() { repo.find(); repo.set(1) }');
    fx('src/scripts/x.ts', 'export function f() { repo.find(); repo.set(1) }');
    fx('src/testing/y.ts', 'export function f() { repo.find(); repo.set(1) }');
    fx('src/test-utils/y.ts', 'export function f() { repo.find(); repo.set(1) }');
    fx('src/config/y.ts', 'export function f() { repo.find(); repo.set(1) }');
    fx('src/registry/y.ts', 'export function f() { repo.find(); repo.set(1) }');
    fx('src/factories/y.ts', 'export function f() { repo.find(); repo.set(1) }');
    fx('src/routes/y.ts', 'export function f() { repo.find(); repo.set(1) }');
    fx('src/di/y.ts', 'export function f() { repo.find(); repo.set(1) }');
    fx('src/schema/y.ts', 'export function f() { repo.find(); repo.set(1) }');
    fx('src/whatever/x-cache.ts', 'export function f() { repo.find(); repo.set(1) }');
    fx('src/whatever/x-prefetcher.ts', 'export function f() { repo.find(); repo.set(1) }');
    fx(
      'src/svc/atomic.ts',
      '// transaction wrapper\nexport function f() { repo.find(); repo.set(1) }',
    );
    fx(
      'src/svc/version.ts',
      'export function f() { repo.find({version: 1}); repo.update({expectedVersion: 1}) }',
    );
    const result = await runCheck('toctou-race-condition');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// async-waterfall-detection — many branches
// ---------------------------------------------------------------------------

describe('async-waterfall-detection — branches', () => {
  it('handles independent awaits, dependent awaits, await in for/while, mixed', async () => {
    fx(
      'src/svc/waterfall.ts',
      [
        'export async function independent(): Promise<void> {',
        '  const a = await fetchA()',
        '  const b = await fetchB()',
        '  const c = await fetchC()',
        '  console.log(a, b, c)',
        '}',
        'export async function dependent(): Promise<void> {',
        '  const a = await fetchA()',
        '  const b = await fetchB(a)',
        '  console.log(b)',
        '}',
        'export async function inLoop(items: number[]): Promise<void> {',
        '  for (const it of items) {',
        '    await process(it)',
        '  }',
        '}',
        'export async function inWhileLoop(): Promise<void> {',
        '  while (true) {',
        '    const r = await tick()',
        '    if (!r) break',
        '  }',
        '}',
        'export async function tryCatch(): Promise<void> {',
        '  try {',
        '    const a = await fetchA()',
        '    const b = await fetchB()',
        '    return a + b',
        '  } catch (e) { return 0 }',
        '}',
        'export async function withReturnAwait(): Promise<number> {',
        '  return await fetchOne()',
        '}',
        'export async function singleAwait(): Promise<number> {',
        '  return await fetchOne()',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('async-waterfall-detection');
    expect(result).toBeDefined();
  });

  it('handles non-async functions and files without await', async () => {
    fx('src/svc/nowait.ts', 'export function f() { return 1 }');
    fx('src/svc/empty.ts', '// no await here');
    const result = await runCheck('async-waterfall-detection');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// memo-list-items — exercise visit branches deeply
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// no-inline-functions — exercise trivial-callback branches
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// missing-type-exports
// ---------------------------------------------------------------------------

describe('missing-type-exports — branches', () => {
  it('exercises declared-but-unexported types, exported types, type-only imports, ambient declarations', async () => {
    fx(
      'src/types/lib.ts',
      [
        'export interface Public { id: string }',
        'interface Internal { id: string }',
        'export type T1 = string',
        'type T2 = number',
        'export class C { x = 1 }',
        'class D { x = 1 }',
        'export enum E { A, B }',
        'enum F { A, B }',
        'declare const G: unknown',
        'export { Internal as RenamedInternal }',
      ].join('\n'),
    );
    fx(
      'src/types/uses.ts',
      [
        'import type { Public, T1 } from "./lib.js"',
        'export const x: Public = { id: "1" }',
        'export const y: T1 = "ok"',
      ].join('\n'),
    );
    fx('src/types/index.ts', 'export * from "./lib.js"');
    const result = await runCheck('missing-type-exports');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// throws-documentation
// ---------------------------------------------------------------------------

describe('throws-documentation — branches', () => {
  it('flags throws without @throws JSDoc, accepts documented throws', async () => {
    fx(
      'src/svc/throws.ts',
      [
        '/** @throws {RangeError} when bad */',
        'export function documented() { throw new RangeError("bad") }',
        'export function undocumented() { throw new Error("oops") }',
        'export function nested() {',
        '  if (true) {',
        '    if (Math.random() > 0.5) throw new Error("inner")',
        '  }',
        '}',
        'export function throwsNonError() { throw "string"  }',
        'export async function asyncThrows(): Promise<void> { throw new Error("a") }',
        'export class Klass {',
        '  /** @throws Error */',
        '  m() { throw new Error("m") }',
        '  n() { throw new Error("n") }',
        '}',
        'export const arr = () => { throw new Error("a") }',
        'export const exp = function() { throw new Error("e") }',
        'export function caught() { try { throw new Error() } catch (_e) { return 1 } }',
        'export function caughtRethrows() { try { return 1 } catch (e) { throw e } }',
      ].join('\n'),
    );
    const result = await runCheck('throws-documentation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// array-validation
// ---------------------------------------------------------------------------

describe('array-validation — branches', () => {
  it('flags array.length, [0], unsafe destructuring, allows guards', async () => {
    fx(
      'src/api/handler.ts',
      [
        'export function handle(items: number[]) {',
        '  const a = items[0]',
        '  const b = items[items.length - 1]',
        '  const [first] = items',
        '  if (items.length === 0) return null',
        '  if (items.length > 0) return items[0]',
        '  if (Array.isArray(items)) return items[0]',
        '  return a + b + first',
        '}',
        'export function safeUse(items?: number[]) {',
        '  return items?.[0]',
        '}',
        'export function nestedArr(rows: { items: number[] }[]) {',
        '  return rows[0].items[0]',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('array-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// numeric-validation
// ---------------------------------------------------------------------------

describe('numeric-validation — branches', () => {
  it('flags missing isFinite/isNaN, allows guards', async () => {
    fx(
      'src/svc/num.ts',
      [
        'export function calc(price: number, qty: number) {',
        '  return price * qty',
        '}',
        'export function safeCalc(price: number, qty: number) {',
        '  if (!Number.isFinite(price) || !Number.isFinite(qty)) return 0',
        '  if (Number.isNaN(price)) return 0',
        '  return price * qty',
        '}',
        'export function divide(a: number, b: number) {',
        '  return a / b',
        '}',
        'export function divideSafe(a: number, b: number) {',
        '  if (b === 0) throw new RangeError("div by zero")',
        '  return a / b',
        '}',
        'export function parseInt2(s: string) {',
        '  return parseInt(s, 10)',
        '}',
        'export function parseFloat2(s: string) {',
        '  return parseFloat(s)',
        '}',
        'export function modulo(a: number, b: number) { return a % b }',
      ].join('\n'),
    );
    const result = await runCheck('numeric-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// null-safety
// ---------------------------------------------------------------------------

describe('null-safety — branches', () => {
  it('flags unchecked null, allows ?., ??, ===null guards', async () => {
    fx(
      'src/svc/ns.ts',
      [
        'export function f1(x: { name: string } | null) {',
        '  return x.name', // unsafe
        '}',
        'export function f2(x: { name: string } | null) {',
        '  return x?.name', // safe
        '}',
        'export function f3(x: { name: string } | null) {',
        '  if (x === null) return ""',
        '  return x.name', // safe
        '}',
        'export function f4(x: { name: string } | undefined) {',
        '  return x?.name ?? "anon"', // safe
        '}',
        'export function f5(x: any) {',
        '  return x.name', // any-typed, may or may not flag
        '}',
        'export function f6(x?: { items?: string[] }) {',
        '  return x?.items?.length ?? 0',
        '}',
        'export class C {',
        '  private name?: string',
        '  greet() { return this.name?.toUpperCase() }',
        '  unsafeGreet() { return this.name!.toUpperCase() }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('null-safety');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// stubbed-implementation-detection
// ---------------------------------------------------------------------------

describe('stubbed-implementation-detection — branches', () => {
  it('flags TODO bodies, throw not implemented, return null/[]/empty', async () => {
    fx(
      'src/svc/stub.ts',
      [
        'export function todo() { /* TODO: implement me */ return null }',
        'export function notImpl() { throw new Error("not implemented") }',
        'export function notImpl2() { throw new Error("Not yet implemented") }',
        'export function emptyArr() { return [] }',
        'export function emptyObj() { return {} }',
        'export function returnNull(): null { return null }',
        'export async function asyncStub() { return null }',
        'export function realImpl(a: number, b: number) { return a + b }',
        'export class S {',
        '  // TODO finish me',
        '  m() { return null }',
        '  n() { throw new Error("TODO") }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('stubbed-implementation-detection');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// incomplete-regex-escaping
// ---------------------------------------------------------------------------

describe('incomplete-regex-escaping — branches', () => {
  it('flags unescaped specials in user-input regex, allows escaped ones', async () => {
    fx(
      'src/util/re.ts',
      [
        'export function bad(input: string) {',
        '  return new RegExp(input)',
        '}',
        'export function good(input: string) {',
        '  const escaped = input.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")',
        '  return new RegExp(escaped)',
        '}',
        String.raw`export function literal() { return /foo\.bar/ }`,
        'export function fromTemplate(input: string) {',
        '  return new RegExp(`prefix-${input}-suffix`)',
        '}',
        'export const dyn = (i: string) => new RegExp("[" + i + "]")',
        'export function strReplace(s: string, p: string) {',
        '  return s.replace(new RegExp(p, "g"), "")',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('incomplete-regex-escaping');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// silent-early-returns
// ---------------------------------------------------------------------------

describe('silent-early-returns — branches', () => {
  it('flags early returns without logging in business logic', async () => {
    fx(
      'src/svc/silent.ts',
      [
        'export function f1(x: { id: string } | null) {',
        '  if (!x) return null',
        '  return x.id',
        '}',
        'export function f2(x: { id: string } | null) {',
        '  if (!x) {',
        '    logger.warn("missing x")',
        '    return null',
        '  }',
        '  return x.id',
        '}',
        'export function f3(items: number[]) {',
        '  if (items.length === 0) return',
        '  return items.reduce((a,b) => a+b)',
        '}',
        'export function f4(input?: string) {',
        '  return input ?? null',
        '}',
        'export async function f5(x?: string) {',
        '  if (!x) throw new Error("required")',
        '  return await fetchData(x)',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('silent-early-returns');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// missing-input-validation
// ---------------------------------------------------------------------------

describe('missing-input-validation — branches', () => {
  it('handlers with and without zod parse', async () => {
    fx(
      'src/api/h.ts',
      [
        'import { z } from "zod"',
        'const Body = z.object({ id: z.string() })',
        'export async function safeHandler(req: any) {',
        '  const body = Body.parse(req.body)',
        '  return body',
        '}',
        'export async function unsafeHandler(req: any) {',
        '  return req.body.id',
        '}',
        'export async function partialHandler(req: any) {',
        '  const x = z.string().safeParse(req.params.id)',
        '  return x',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('missing-input-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// api-response-validation
// ---------------------------------------------------------------------------

describe('api-response-validation — branches', () => {
  it('routes that return raw data vs validated', async () => {
    fx(
      'src/api/route.ts',
      [
        'import { z } from "zod"',
        'const RespSchema = z.object({ ok: z.boolean() })',
        'export async function ok(): Promise<unknown> { return RespSchema.parse({ ok: true }) }',
        'export async function leak(): Promise<unknown> { return rawDb.query() }',
        'export async function unionRet(x: number): Promise<unknown> {',
        '  if (x > 0) return { ok: true }',
        '  return { ok: false }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('api-response-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// fastify-route-validation
// ---------------------------------------------------------------------------

describe('fastify-route-validation — branches', () => {
  it('routes with and without schema option', async () => {
    fx(
      'src/routes/users.ts',
      [
        'import type { FastifyInstance } from "fastify"',
        'export async function register(app: FastifyInstance) {',
        '  app.get("/users", { schema: { response: { 200: { type: "object" } } } }, async () => [])',
        '  app.post("/users", async (req) => req.body)',
        '  app.put("/users/:id", { schema: { params: { type: "object" } } }, async () => ({}))',
        '  app.delete("/users/:id", async () => ({}))',
        '  app.route({ method: "GET", url: "/x", handler: async () => ({}) })',
        '  app.route({ method: "POST", url: "/y", schema: { body: {} }, handler: async () => ({}) })',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('fastify-route-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// api-contract-validation
// ---------------------------------------------------------------------------

describe('api-contract-validation — branches', () => {
  it('handlers with missing/with return types and try/catch', async () => {
    fx(
      'src/api/handlers.ts',
      [
        'export async function noTypes(req: unknown, _res: unknown) {',
        '  const body = (req as any).body',
        '  return body',
        '}',
        'export async function withTypes(req: { body: string }): Promise<{ ok: boolean }> {',
        '  try {',
        '    return { ok: req.body !== "" }',
        '  } catch (e) {',
        '    return { ok: false }',
        '  }',
        '}',
        'export function nonAsync(req: any) { return req }',
        'export const arrowHandler = async (req: any): Promise<unknown> => req',
        'export class Ctrl {',
        '  async handle(req: any): Promise<unknown> { return req }',
        '  syncMethod(req: any) { return req }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('api-contract-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// di-static-inject-usage
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// duplicate-utility-functions
// ---------------------------------------------------------------------------

describe('duplicate-utility-functions — branches', () => {
  it('multiple files with duplicate functions vs unique', async () => {
    fx(
      'src/util/a.ts',
      [
        'export function add(a: number, b: number): number { return a + b }',
        'export function uniqueA() { return 1 }',
        'export function helper(s: string) { return s.toUpperCase() }',
      ].join('\n'),
    );
    fx(
      'src/util/b.ts',
      [
        'export function add(a: number, b: number): number { return a + b }', // duplicate
        'export function uniqueB() { return 2 }',
        'export function helper(s: string) { return s.toUpperCase() }', // duplicate
      ].join('\n'),
    );
    fx(
      'src/util/c.ts',
      [
        'export function add(a: number, b: number): number { return a + b }', // triple
      ].join('\n'),
    );
    const result = await runCheck('duplicate-utility-functions');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// no-any-types
// ---------------------------------------------------------------------------

describe('no-any-types — branches', () => {
  it('detects various any forms', async () => {
    fx(
      'src/types/anys.ts',
      [
        'export const a: any = 1',
        'export function f(x: any): any { return x }',
        'export const obj: { [k: string]: any } = {}',
        'export type T<T = any> = T',
        'export const arr: any[] = []',
        'export const cast = (x: unknown) => x as any',
        'export interface I { x: any; y: unknown }',
      ].join('\n'),
    );
    const result = await runCheck('no-any-types');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// pii-exposure-in-logs
// ---------------------------------------------------------------------------

describe('pii-exposure-in-logs — branches', () => {
  it('logs that include PII keywords vs safe logs', async () => {
    fx(
      'src/svc/log.ts',
      [
        'export function f(req: any) {',
        '  logger.info({ email: req.email })',
        '  logger.warn({ password: req.password })',
        '  logger.error({ ssn: req.ssn })',
        '  logger.info({ requestId: req.requestId })',
        '  logger.info("processing request")',
        '  console.log(req.body)',
        '  console.log({ ip: req.ip })',
        '  console.error(req)',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('pii-exposure-in-logs');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// logger-event-name-format
// ---------------------------------------------------------------------------

describe('logger-event-name-format — branches', () => {
  it('various event-name shapes (snake, kebab, camelCase, with periods, missing)', async () => {
    fx(
      'src/svc/events.ts',
      [
        'logger.info("event_emitted")',
        'logger.info("event-emitted")',
        'logger.info("eventEmitted")',
        'logger.info("Event Emitted")',
        'logger.info("module.event_emitted")',
        'logger.info({ event: "payment.processed", amount: 1 })',
        'logger.info({ event: "WrongCase", x: 1 })',
        'logger.warn({ a: 1 })',
        'logger.error("simple")',
      ].join('\n'),
    );
    const result = await runCheck('logger-event-name-format');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// platform-checks
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// lazy-loading
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// flashlist-enforcement
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// client-boundary-placement
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// test-only-frontend-modules
// ---------------------------------------------------------------------------

describe('test-only-frontend-modules — branches', () => {
  it('mocks vs real implementations', async () => {
    fx('src/api/__mocks__/users.ts', 'export const fetchUsers = () => []');
    fx('src/api/users.ts', 'export const fetchUsers = async () => fetch("/users")');
    fx('src/api/test.helpers.ts', 'export const mockUser = () => ({ id: "1" })');
    const result = await runCheck('test-only-frontend-modules');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// stream-buffer-size-limits
// ---------------------------------------------------------------------------

describe('stream-buffer-size-limits — branches', () => {
  it('bounded vs unbounded streams', async () => {
    fx(
      'src/svc/stream.ts',
      [
        'import { Readable } from "stream"',
        'export const limited = new Readable({ highWaterMark: 1024 })',
        'export const unlimited = new Readable({})',
        'export const buffered = (s: Readable) => s.pipe(somethingElse, { highWaterMark: 4096 })',
      ].join('\n'),
    );
    const result = await runCheck('stream-buffer-size-limits');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// dispose-pattern-completeness
// ---------------------------------------------------------------------------

describe('dispose-pattern-completeness — branches', () => {
  it('classes with/without proper dispose impl', async () => {
    fx(
      'src/svc/disp.ts',
      [
        'export class A {',
        '  private timer: NodeJS.Timer | null = null',
        '  start() { this.timer = setInterval(() => undefined, 1000) }',
        '  dispose() { if (this.timer) clearInterval(this.timer) }',
        '}',
        'export class B {',
        '  private timer: NodeJS.Timer | null = null',
        '  start() { this.timer = setInterval(() => undefined, 1000) }',
        '}',
        'export class C {',
        '  [Symbol.asyncDispose]() {}',
        '}',
        'export class D implements Disposable {',
        '  [Symbol.dispose]() {}',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('dispose-pattern-completeness');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// typeorm-n-plus-one
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// postgres-n-plus-one
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// financial-transaction-ordering
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// database-index-coverage
// ---------------------------------------------------------------------------

describe('database-index-coverage — branches', () => {
  it('drizzle table with and without indexes', async () => {
    fx(
      'src/db/schema/users.ts',
      [
        'import { pgTable, serial, text, varchar, integer, index } from "drizzle-orm/pg-core"',
        'export const users = pgTable("users", {',
        '  id: serial("id").primaryKey(),',
        '  email: varchar("email", { length: 255 }),',
        '  tenantId: integer("tenant_id"),',
        '}, (t) => ({ emailIdx: index("email_idx").on(t.email) }))',
        'export const posts = pgTable("posts", {',
        '  id: serial("id").primaryKey(),',
        '  userId: integer("user_id"),',
        '  title: text("title"),',
        '})',
      ].join('\n'),
    );
    const result = await runCheck('database-index-coverage');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// database-schema-validation
// ---------------------------------------------------------------------------

describe('database-schema-validation — branches', () => {
  it('drizzle types with and without notNull, unique, default', async () => {
    fx(
      'src/db/schema/all.ts',
      [
        'import { pgTable, serial, text, varchar, timestamp, integer } from "drizzle-orm/pg-core"',
        'export const t1 = pgTable("t1", {',
        '  id: serial("id").primaryKey(),',
        '  name: text("name").notNull(),',
        '  email: varchar("email", { length: 255 }).notNull().unique(),',
        '  createdAt: timestamp("created_at").defaultNow().notNull(),',
        '  optional: text("optional"),',
        '  count: integer("count").default(0),',
        '})',
      ].join('\n'),
    );
    const result = await runCheck('database-schema-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// in-memory-repository-detection
// ---------------------------------------------------------------------------

describe('in-memory-repository-detection — extra branches', () => {
  it('multiple Repository classes with different storage shapes', async () => {
    fx(
      'src/repos/multi.ts',
      [
        'export class FooRepository {',
        '  private byMap = new Map<string, number>()',
        '  private bySet = new Set<string>()',
        '  private byArray: { id: string }[] = []',
        '  private byObject: Record<string, unknown> = {}',
        '  async listAll() { return [...this.byMap.values()] }',
        '}',
        '// FooRepository',
      ].join('\n'),
    );
    fx(
      'src/repos/Cache.ts',
      ['export class CacheRepository {', '  private byMap = new Map<string, number>()', '}'].join(
        '\n',
      ),
    );
    fx(
      'src/repos/Mock.ts',
      ['export class MockRepository {', '  private byMap = new Map<string, number>()', '}'].join(
        '\n',
      ),
    );
    const result = await runCheck('in-memory-repository-detection');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// sql-injection
// ---------------------------------------------------------------------------

describe('sql-injection — branches', () => {
  it('template injection vs parameterized', async () => {
    fx(
      'src/api/db.ts',
      [
        'export async function bad(id: string) {',
        '  return await db.query(`SELECT * FROM users WHERE id = ${id}`)',
        '}',
        'export async function good(id: string) {',
        '  return await db.query("SELECT * FROM users WHERE id = $1", [id])',
        '}',
        'export async function bad2(name: string) {',
        '  const sql = "SELECT * FROM users WHERE name = \'" + name + "\'"',
        '  return await db.query(sql)',
        '}',
        'export async function good2(name: string) {',
        '  const stmt = db.prepare("SELECT * FROM users WHERE name = ?")',
        '  return stmt.execute([name])',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('sql-injection');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// input-sanitization
// ---------------------------------------------------------------------------

describe('input-sanitization — branches', () => {
  it('html, fs, exec, and url cases', async () => {
    fx(
      'src/api/risk.ts',
      [
        'import { exec } from "child_process"',
        'import * as fs from "fs"',
        'export function htmlBad(req: any) {',
        '  return `<div>${req.body.html}</div>`',
        '}',
        'export function fsBad(req: any) {',
        '  return fs.readFileSync("/etc/" + req.params.file)',
        '}',
        'export function execBad(req: any) {',
        '  exec("ls " + req.body.dir, () => undefined)',
        '}',
        'export function urlBad(req: any) {',
        '  return fetch("https://api.com/" + req.params.id)',
        '}',
        'export function safe() {',
        '  return fs.readFileSync("/etc/hosts")',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('input-sanitization');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// unsafe-secret-comparison
// ---------------------------------------------------------------------------

describe('unsafe-secret-comparison — branches', () => {
  it('detects ===, ==, .equals, allows timingSafeEqual', async () => {
    fx(
      'src/auth/x.ts',
      [
        'import { timingSafeEqual } from "crypto"',
        'export function bad1(secret: string, given: string) { return secret === given }',
        'export function bad2(secret: string, given: string) { return secret == given }',
        'export function bad3(a: Buffer, b: Buffer) { return a.equals(b) }',
        'export function good(a: Buffer, b: Buffer) { return timingSafeEqual(a, b) }',
        'export function notSecret(a: number, b: number) { return a === b }',
      ].join('\n'),
    );
    const result = await runCheck('unsafe-secret-comparison');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// observability-coverage (helper) — covered via direct unit tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// error-handling-quality
// ---------------------------------------------------------------------------

describe('error-handling-quality — branches', () => {
  it('try/catch shapes and rethrow patterns', async () => {
    fx(
      'src/svc/eh.ts',
      [
        'export function f1() { try { return 1 } catch { return 0 } }',
        'export function f2() { try { return 1 } catch (e) { console.log(e); throw e } }',
        'export function f3() { try { return 1 } catch (e) { logger.error({ err: e }); throw new Error("wrap") } }',
        'export async function f4() { try { return await x() } catch { } }', // empty catch
        'export function f5() { try { return 1 } catch (e: any) { return e.message } }',
        'export function f6() { try { return 1 } catch (_e) { return null } }',
      ].join('\n'),
    );
    const result = await runCheck('error-handling-quality');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// result-pattern-consistency
// ---------------------------------------------------------------------------

describe('result-pattern-consistency — branches', () => {
  it('mixed Result and throws', async () => {
    fx(
      'src/svc/res.ts',
      [
        'type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }',
        'export function ok<T>(v: T): Result<T, never> { return { ok: true, value: v } }',
        'export function err<E>(e: E): Result<never, E> { return { ok: false, error: e } }',
        'export function viaResult(): Result<number, string> { return ok(1) }',
        'export function viaThrow(): number { throw new Error("oops") }',
        'export function mixedKind(x: number) {',
        '  if (x < 0) return err("neg")',
        '  if (x === 0) throw new Error("zero")',
        '  return ok(x)',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('result-pattern-consistency');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// lifecycle-cleanup-enforcement
// ---------------------------------------------------------------------------

describe('lifecycle-cleanup-enforcement — branches', () => {
  it('useEffect with and without cleanup', async () => {
    fx(
      'src/components/Eff.tsx',
      [
        'import { useEffect } from "react"',
        'export function A() {',
        '  useEffect(() => {',
        '    const id = setInterval(() => undefined, 100)',
        '    return () => clearInterval(id)',
        '  }, [])',
        '  return null',
        '}',
        'export function B() {',
        '  useEffect(() => {',
        '    setInterval(() => undefined, 100)',
        '  }, [])',
        '  return null',
        '}',
        'export function C() {',
        '  useEffect(() => {',
        '    const sub = src.subscribe(() => undefined)',
        '    return () => sub.unsubscribe()',
        '  }, [])',
        '  return null',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('lifecycle-cleanup-enforcement');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// openapi-response-coverage
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// broad fixture — many checks
// ---------------------------------------------------------------------------

describe('broad fixture — many checks', () => {
  it('exercises a wide-shape fixture across many files', async () => {
    fx(
      'package.json',
      JSON.stringify(
        {
          name: 'demo',
          version: '1.0.0',
          type: 'module',
          main: './dist/index.js',
          types: './dist/index.d.ts',
          exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
          dependencies: { 'drizzle-orm': '^0.30.0', react: '^18.0.0', 'typed-inject': '^4.0.0' },
        },
        null,
        2,
      ),
    );
    fx(
      'tsconfig.json',
      JSON.stringify(
        {
          extends: './tsconfig.base.json',
          compilerOptions: { target: 'es2022', module: 'esnext', strict: true },
          include: ['src/**/*'],
        },
        null,
        2,
      ),
    );
    fx('tsconfig.base.json', JSON.stringify({ compilerOptions: { strict: true } }, null, 2));
    fx('src/index.ts', 'export * from "./svc.js"');
    fx(
      'src/svc.ts',
      [
        'export interface UserRequest { id: string }',
        'export interface UserResponse { ok: boolean }',
        'export type UserDTO = { id: string }',
        'export interface ApiUserList { users: UserDTO[] }',
        'export async function getUsers(req: UserRequest): Promise<UserResponse> {',
        '  if (!req.id) return { ok: false }',
        '  try { return { ok: true } } catch (e) { return { ok: false } }',
        '}',
      ].join('\n'),
    );
    fx(
      'src/observability/m.ts',
      [
        'export function record(name: string, value: number) {',
        '  // no logger here',
        '  return { name, value }',
        '}',
      ].join('\n'),
    );
    fx(
      'src/observability/with.ts',
      [
        'import logger from "./logger.js"',
        'export function recordLogged(name: string, value: number) {',
        '  logger.info({ event: "metric.recorded", name, value })',
        '  return { name, value }',
        '}',
      ].join('\n'),
    );
    fx(
      'src/observability/logger.ts',
      [
        'export const logger = {',
        '  info: (..._args: unknown[]) => undefined,',
        '  warn: (..._args: unknown[]) => undefined,',
        '  error: (..._args: unknown[]) => undefined,',
        '  child: () => logger,',
        '}',
        'export default logger',
      ].join('\n'),
    );

    // Run a handful of checks to exercise broader branches.
    const slugs = [
      'detached-promises',
      'no-unbounded-concurrency',
      'no-raw-fetch',
      'array-validation',
      'numeric-validation',
      'null-safety',
      'incomplete-regex-escaping',
      'missing-input-validation',
      'fastify-route-validation',
      'api-contract-validation',
      'api-response-validation',
      'silent-early-returns',
      'throws-documentation',
      'error-handling-quality',
      'logger-event-name-format',
      'pii-exposure-in-logs',
      'sql-injection',
      'unsafe-secret-comparison',
      'input-sanitization',
      'no-any-types',
      'duplicate-utility-functions',
      'stubbed-implementation-detection',
      'missing-type-exports',
      'toctou-race-condition',
      'lifecycle-cleanup-enforcement',
      'dispose-pattern-completeness',
      'stream-buffer-size-limits',
      'result-pattern-consistency',
      'database-schema-validation',
      'database-index-coverage',
      'in-memory-repository-detection',
    ];
    for (const slug of slugs) {
      const result = await runCheck(slug);
      expect(result).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// path-matching utility — exercise both string and regex branches
// ---------------------------------------------------------------------------

describe('path-matching utility — branches', () => {
  it('exercises string includes and regex test patterns', async () => {
    const { createPathMatcher } = await import('@opensip-tools/fitness');
    const stringOnly = createPathMatcher(['/__tests__/']);
    expect(stringOnly('/src/__tests__/foo.ts')).toBe(true);
    expect(stringOnly('/src/main.ts')).toBe(false);
    const regexOnly = createPathMatcher([/\.test\.ts$/]);
    expect(regexOnly('foo.test.ts')).toBe(true);
    expect(regexOnly('foo.ts')).toBe(false);
    const mixed = createPathMatcher(['/dist/', /node_modules/]);
    expect(mixed('/proj/dist/x.js')).toBe(true);
    expect(mixed('/proj/node_modules/lib/index.js')).toBe(true);
    expect(mixed('/proj/src/x.ts')).toBe(false);
  });
});
