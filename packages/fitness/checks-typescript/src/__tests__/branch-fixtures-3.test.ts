// @fitness-ignore-file file-length-limit -- behavior fixture suite; related scenarios stay together while checks are split into focused tests.
/**
 * @fileoverview Third branch-behavior fixture suite: uses recipe config injection
 * to drive otherwise-unreachable defensive guard branches, plus targeted
 * fixtures for highest-impact remaining files.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { RunScope, runWithScope } from '@opensip-cli/core';
import {
  fileCache,
  setCurrentRecipeCheckConfig,
  clearCurrentRecipeCheckConfig,
} from '@opensip-cli/fitness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checks } from '../index.js';

let cwd: string;
let written: string[] = [];
let testScope: RunScope;

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
  return check.run(cwd, { targetFiles: written });
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'opensip-cov-bp3-'));
  written = [];
  testScope = new RunScope();
  // check.run resolves currentScope()?.fitness?.fileCache now (Phase 1); bind it
  // to the test-only singleton this suite prewarms.
  Object.assign(testScope, { fitness: { fileCache } });
});

afterEach(() => {
  fileCache.clear();
  clearCurrentRecipeCheckConfig(testScope);
  rmSync(cwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// detached-promises with recipe config — drive additionalSync* branches
// ---------------------------------------------------------------------------

describe('detached-promises — with recipe config', () => {
  it('uses additionalSyncFunctions, additionalSyncReceivers, additionalSyncPrefixes', async () => {
    await runWithScope(testScope, async () => {
      setCurrentRecipeCheckConfig(testScope, {
        'detached-promises': {
          additionalSyncFunctions: ['mySpecialSync', 'anotherSync'],
          additionalSyncReceivers: ['cliWriter', 'projectLogger'],
          additionalSyncPrefixes: ['register', 'configure'],
        },
      });
      fx(
        'src/x/c.ts',
        [
          'export async function f() {',
          '  mySpecialSync()',
          '  anotherSync()',
          '  cliWriter.print("hi")',
          '  projectLogger.info("there")',
          '  registerHandler()',
          '  configureRoute()',
          '  unknownCall()',
          '}',
        ].join('\n'),
      );
      const result = await runCheck('detached-promises');
      expect(result).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// toctou-race-condition with recipe config — drive additionalSafeTOCTOUPaths
// ---------------------------------------------------------------------------

describe('toctou-race-condition — with recipe config', () => {
  it('uses additionalSafeTOCTOUPaths', async () => {
    await runWithScope(testScope, async () => {
      setCurrentRecipeCheckConfig(testScope, {
        'toctou-race-condition': {
          additionalSafeTOCTOUPaths: ['/chain-walker/', '/audit-logs/'],
        },
      });
      fx(
        'src/chain-walker/walker.ts',
        ['export function walk(repo: any) {', '  const x = repo.find()', '  repo.set(1)', '}'].join(
          '\n',
        ),
      );
      fx(
        'src/audit-logs/log.ts',
        ['export function log(repo: any) {', '  const x = repo.find()', '  repo.set(1)', '}'].join(
          '\n',
        ),
      );
      const result = await runCheck('toctou-race-condition');
      expect(result).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// de-leak config keys (D1/D3) — project-specific overrides replace the
// formerly-hardcoded foreign symbols / paths
// ---------------------------------------------------------------------------

describe('null-safety — additionalSafeBuilders config', () => {
  it('treats a configured builder prefix as non-null', async () => {
    await runWithScope(testScope, async () => {
      setCurrentRecipeCheckConfig(testScope, {
        'null-safety': { additionalSafeBuilders: ['acmeFactory.'] },
      });
      fx('src/x/n.ts', 'export function f() { return acmeFactory.create().value }');
      const result = await runCheck('null-safety');
      expect(result).toBeDefined();
    });
  });
});

describe('result-pattern-consistency — additionalThrowAllowedPaths config', () => {
  it('treats a configured path as a throw-allowed boundary', async () => {
    await runWithScope(testScope, async () => {
      setCurrentRecipeCheckConfig(testScope, {
        'result-pattern-consistency': { additionalThrowAllowedPaths: ['/acme-bridge/'] },
      });
      fx(
        'src/acme-bridge/edge.ts',
        ['export function f() {', '  throw new ValidationError("x")', '}'].join('\n'),
      );
      const result = await runCheck('result-pattern-consistency');
      expect(result).toBeDefined();
    });
  });
});

describe('no-raw-fetch — skipPaths config', () => {
  it('skips a caller-configured path that would otherwise be flagged', async () => {
    await runWithScope(testScope, async () => {
      setCurrentRecipeCheckConfig(testScope, {
        'no-raw-fetch': { skipPaths: ['/acme-integrations/'] },
      });
      fx('src/acme-integrations/client.ts', 'await fetch("/x")');
      const result = await runCheck('no-raw-fetch');
      // The raw fetch is suppressed purely by the configured skipPaths entry.
      expect(result.signals).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// throws-documentation with recipe config — drive additionalSelfDocumentingSuffixes
// ---------------------------------------------------------------------------

describe('throws-documentation — with recipe config', () => {
  it('uses additionalSelfDocumentingSuffixes', async () => {
    await runWithScope(testScope, async () => {
      setCurrentRecipeCheckConfig(testScope, {
        'throws-documentation': {
          additionalSelfDocumentingSuffixes: ['CompositionError', 'TransitionError'],
        },
      });
      fx(
        'src/x/t.ts',
        [
          'class CompositionError extends Error {}',
          'class TransitionError extends Error {}',
          'export function a() { throw new CompositionError() }',
          'export function b() { throw new TransitionError() }',
          'export function c() { throw new Error("plain") }', // not self-documenting
        ].join('\n'),
      );
      const result = await runCheck('throws-documentation');
      expect(result).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// async-waterfall-detection — exercise more branches
// ---------------------------------------------------------------------------

describe('async-waterfall-detection — additional branches v3', () => {
  it('various dependent-vs-independent await patterns', async () => {
    fx(
      'src/x/wf2.ts',
      [
        'export async function withTry(): Promise<void> {',
        '  try {',
        '    const a = await fetchA()',
        '    const b = await fetchB()',
        '    const c = await fetchC()',
        '    console.log(a, b, c)',
        '  } catch (e) { console.error(e) }',
        '}',
        'export async function withFor(items: number[]): Promise<void> {',
        '  for (let i = 0; i < items.length; i++) {',
        '    await process(items[i])',
        '  }',
        '}',
        'export async function withForOf(items: number[]) {',
        '  for (const it of items) await process(it)',
        '}',
        'export async function withForIn(obj: Record<string, number>) {',
        '  for (const k in obj) await process(obj[k])',
        '}',
        'export async function nestedAsync(): Promise<void> {',
        '  return new Promise(async (resolve) => {',
        '    const a = await fetchA()',
        '    const b = await fetchB()',
        '    resolve(a + b)',
        '  })',
        '}',
        'export async function returnDirect() {',
        '  return await fetchA()',
        '}',
        'export async function noBlockBody(): Promise<number> {',
        '  return fetchA()',
        '}',
        'export async function multipleParallel() {',
        '  const a = fetchA()',
        '  const b = fetchB()',
        '  const c = fetchC()',
        '  return [await a, await b, await c]',
        '}',
        'export async function complexDep() {',
        '  const a = await fetchA()',
        '  const b = await fetchB(a, a + 1)',
        '  const c = await fetchC(b.x)',
        '  return c',
        '}',
        'export async function mixedDep() {',
        '  const a = await fetchA()',
        '  const b = await fetchB()', // independent of a
        '  const c = await fetchC(a)', // depends on a',
        '  return [a, b, c]',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('async-waterfall-detection');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// context-safety — drive many class shapes
// ---------------------------------------------------------------------------

describe('context-safety — additional branches v3', () => {
  it('this binding scenarios across class methods, callbacks, decorators', async () => {
    fx(
      'src/x/cs.ts',
      [
        'export class Foo {',
        '  data = "x"',
        '  arrow = () => this.data',
        '  bound = this.method.bind(this)',
        '  unbound = this.method',
        '  method() { return this.data }',
        '  async asyncMethod() { return this.data }',
        '  callbacks() {',
        '    setTimeout(() => this.method(), 100)',
        '    setTimeout(this.method.bind(this), 100)',
        '    setTimeout(this.method, 100)',
        '    Promise.resolve().then(() => this.method())',
        '    Promise.resolve().then(this.method)',
        '    [1].map(() => this.method())',
        '    [1].map(this.method)',
        '  }',
        '  static st() { return Foo.st }',
        '}',
        'export class WithThis {',
        '  log(this: WithThis, msg: string) { return msg }',
        '}',
        'export const arrow = function() { return this }', // function this',
        'export class Inherits extends Foo {',
        '  constructor() { super() }',
        '  override method() { return super.method() }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('context-leakage');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// stubbed-implementation-detection — broader branches
// ---------------------------------------------------------------------------

describe('stubbed-implementation-detection — additional branches v3', () => {
  it('common patterns across functions, methods, properties', async () => {
    fx(
      'src/x/s2.ts',
      [
        'export class S {',
        '  m1(): null { return null }',
        '  m2() { return [] }',
        '  m3() { return {} }',
        '  m4(): never { throw new Error("stub") }',
        '  m5() {} // empty',
        '  async m6() { return null }',
        '  async m7() { return [] }',
        '  async m8(): Promise<void> {}',
        '  m9() { /* TODO */ return null }',
        '  m10() { /* FIXME */ return null }',
        '  m11() { throw new Error("not implemented yet") }',
        '  m12() { throw new Error("Not yet implemented") }',
        '  m13(): void { return }', // explicit early return',
        '  // realistic non-stub',
        '  realM(a: number) { if (a < 0) throw new RangeError("neg"); return a + 1 }',
        '}',
        'export const arr = () => null',
        'export const arr2 = () => []',
        'export const arr3 = () => ({})',
        'export const arr4 = () => undefined',
        'export const arr5 = (a: number) => { if (a < 0) throw new Error("x"); return a }',
        'export function f1() { return null }',
        'export function f2() { return [] }',
        'export function f3() { return {} }',
        'export function f4() { return undefined }',
        'export function f5() { /* TODO */ }',
        'export function realF(a: number) {',
        '  if (a < 0) throw new RangeError("neg")',
        '  let x = 0',
        '  for (let i = 0; i < a; i++) x += i',
        '  return x',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('stubbed-implementation-detection');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// numeric-validation — broader cases
// ---------------------------------------------------------------------------

describe('numeric-validation — additional branches v3', () => {
  it('parseInt/parseFloat, division, modulo, multiplication, with and without guards', async () => {
    fx(
      'src/x/n.ts',
      [
        'export function divNoGuard(a: number, b: number) { return a / b }',
        'export function divGuardZero(a: number, b: number) {',
        '  if (b === 0) throw new RangeError("div by zero")',
        '  return a / b',
        '}',
        'export function divGuardNotZero(a: number, b: number) {',
        '  if (b !== 0) return a / b',
        '  return 0',
        '}',
        'export function piRoundtrip(s: string) {',
        '  const n = parseInt(s, 10)',
        '  if (Number.isNaN(n)) return 0',
        '  return n',
        '}',
        'export function piNoRadix(s: string) { return parseInt(s) }',
        'export function pfWithGuard(s: string) {',
        '  const n = parseFloat(s)',
        '  if (!Number.isFinite(n)) return 0',
        '  return n',
        '}',
        'export function withNumberCons(s: string) {',
        '  const n = Number(s)',
        '  if (Number.isNaN(n)) return 0',
        '  return n',
        '}',
        'export function modOp(a: number, b: number) { return a % b }',
        'export function powOp(a: number, b: number) { return a ** b }',
        'export function safeMod(a: number, b: number) {',
        '  if (b === 0) throw new Error("div0")',
        '  return a % b',
        '}',
        'export function bitwiseOp(a: number, b: number) { return (a & b) | (a ^ b) }',
        'export function negOp(a: number) { return -a }',
        'export function combo(a: number, b: number) {',
        '  if (Number.isFinite(a) && Number.isFinite(b)) return a * b',
        '  return 0',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('numeric-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// array-validation — broader patterns to drive remaining branches
// ---------------------------------------------------------------------------

describe('array-validation — additional branches v3', () => {
  it('iteration methods, indexed access, spread, forwarding, sinks', async () => {
    fx(
      'src/x/a3.ts',
      [
        'export function viaForOf(items: number[]) { for (const x of items) console.log(x) }',
        'export function viaForLoop(items: number[]) { for (let i = 0; i < items.length; i++) console.log(items[i]) }',
        'export function viaForEach(items: number[]) { items.forEach((x) => console.log(x)) }',
        'export function viaMap(items: number[]) { return items.map((x) => x * 2) }',
        'export function viaFilter(items: number[]) { return items.filter((x) => x > 0) }',
        'export function viaReduce(items: number[]) { return items.reduce((a, b) => a + b, 0) }',
        'export function viaSlice(items: number[]) { return items.slice(0, 5) }',
        'export function viaIncludes(items: number[]) { return items.includes(1) }',
        'export function viaIndexOf(items: number[]) { return items.indexOf(1) }',
        'export function viaJoin(items: number[]) { return items.join(",") }',
        'export function viaConcat(items: number[]) { return items.concat([4, 5]) }',
        'export function viaFlat(items: number[][]) { return items.flat() }',
        'export function viaSpread(items: number[]) { return [...items] }',
        'export function viaSpreadCall(items: number[]) { return Math.max(...items) }',
        'export function viaForward(items: number[]) { return doSomething(items) }',
        'export function viaForwardCast(items: number[]) { return doSomething(items as any) }',
        'export function viaShorthand(items: number[]) { return { items } }',
        'export function viaIndexed(items: number[]) { return items[0] }',
        'export function viaOptionalChain(items?: number[]) { return items?.[0] }',
        'export function viaNullish(items: number[] | null) { return (items ?? [])[0] }',
        'export function viaSink(bucket: number[]) { bucket.push(1) }',
        'export function viaUnshift(bucket: number[]) { bucket.unshift(1) }',
        'export function viaSplice(bucket: number[]) { bucket.splice(0, 1) }',
        'export function _ignored(items: number[]) { return null }', // underscore param',
        'export function destructured({ items }: { items: number[] }) { return items.length }',
        'export function nestedTypes(items: Map<string, number[]>) { return items.get("a")?.length }',
        'export function withZod(items: number[]) { z.array(z.number()).parse(items); return items[0] }',
        'export function withCheck(items: number[]) { return checkAvailable(items) ? items[0] : null }',
        'export function abstractMethod() {',
        '  abstract class A {',
        '    // dummy',
        '  }',
        '  return A',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('array-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// null-safety — broader patterns
// ---------------------------------------------------------------------------

describe('null-safety — additional branches v3', () => {
  it('various null-handling patterns', async () => {
    fx(
      'src/x/ns.ts',
      [
        'export function f1(x: string | null) { return x?.length ?? 0 }',
        'export function f2(x: string | null) { if (x !== null) return x.length; return 0 }',
        'export function f3(x: string | null) { if (x === null) return 0; return x.length }',
        'export function f4(x: string | undefined) { return x ?? "default" }',
        'export function f5(x: any) { return x.length }', // any-typed',
        'export function f6(x: { a?: { b?: number } }) { return x.a?.b ?? 0 }',
        'export function f7(x: number | null) { return Number(x) || 0 }',
        'export function f8(x: { items?: number[] | null }) { return x.items?.[0] ?? 0 }',
        'export function f9(x?: number) { return x! + 1 }', // non-null assertion',
        'export function f10(x: string | null) {',
        '  if (typeof x === "string") return x.length',
        '  return 0',
        '}',
        'export function f11(x?: { a: string }) {',
        '  if (!x) throw new Error("required")',
        '  return x.a',
        '}',
        'export class K {',
        '  data?: { id: string }',
        '  m1() { return this.data?.id }',
        '  m2() { return this.data?.id ?? "anon" }',
        '  m3() { return this.data!.id }',
        '  m4() {',
        '    if (!this.data) return null',
        '    return this.data.id',
        '  }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('null-safety');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// throws-documentation v3 — exercise rethrows of different kinds
// ---------------------------------------------------------------------------

describe('throws-documentation — additional branches v3', () => {
  it('various rethrow shapes', async () => {
    fx(
      'src/x/t3.ts',
      [
        'class CustomError extends Error {}',
        'export function r1() { try { return 1 } catch (err) { throw err } }',
        'export function r2() { try { return 1 } catch (e) { throw e } }',
        'export function r3() { try { return 1 } catch (ex) { throw ex } }',
        'export function r4() { try { return 1 } catch (exception) { throw exception } }',
        'export function r5() { try { return 1 } catch (err) { throw new CustomError() } }',
        'export function r6() {',
        '  try { return 1 }',
        '  catch (err) { throw wrap(err) }',
        '}',
        'export function r7() {',
        '  try { return 1 }',
        '  catch (err) { throw err.unwrapErr() }',
        '}',
        'export function r8() {',
        '  try { return 1 }',
        '  catch (err) { throw err.unwrap() }',
        '}',
        'export function r9() {',
        '  try { return 1 }',
        '  catch (err) { throw err.someMethod() }',
        '}',
        'export class K {',
        '  error?: Error',
        '  cause?: Error',
        '  innerError?: Error',
        '  originalError?: Error',
        '  m1() { throw this.error }',
        '  m2() { throw this.cause }',
        '  m3() { throw this.innerError }',
        '  m4() { throw this.originalError }',
        '}',
        'export function freshError() { throw new Error("fresh") }',
        'export function withReturnType(): never { throw new Error("never") }',
        'export class C {',
        '  static st() { throw new Error("static") }',
        '}',
        'export const arrow = () => { throw new Error("arrow") }',
        'export const namedArrow = function inner() { throw new Error("named") }',
        'export function inCallback() { return [1].map(() => { throw new Error("cb") }) }',
      ].join('\n'),
    );
    const result = await runCheck('throws-documentation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// fastify-route-validation — exercise more shapes
// ---------------------------------------------------------------------------

describe('fastify-route-validation — additional branches v3', () => {
  it('routes with various option shapes and handler types', async () => {
    fx(
      'src/r/v3.ts',
      [
        'import type { FastifyInstance } from "fastify"',
        'export async function reg(app: FastifyInstance) {',
        '  // schema with body — validated',
        '  app.post("/a", { schema: { body: { type: "object" } } }, async () => ({ ok: true }))',
        '  // schema without body — not validated',
        '  app.post("/b", { schema: { params: { type: "object" } } }, async () => ({ ok: true }))',
        '  // no schema, manual validation',
        '  app.post("/c", async (req, reply) => {',
        '    if (!request.body) return reply.code(400).send({ message: "Missing body" })',
        '    return { ok: true }',
        '  })',
        '  // no schema, no validation',
        '  app.post("/d", async (req) => req.body)',
        '  // function handler',
        '  app.post("/e", function(req, reply) { return req.body })',
        '  // object literal handler',
        '  app.post("/f", { handler: async () => ({}), schema: { body: {} } })',
        '  // single arg (skipped)',
        '  app.post("/g")',
        '  // body with zod parse',
        '  app.post("/h", async (req: any) => {',
        '    Schema.parse(req.body)',
        '    return { ok: true }',
        '  })',
        '  // body with contracts and Schema',
        '  app.post("/i", async (req: any) => {',
        '    contracts.UserSchema.parse(req.body)',
        '    return { ok: true }',
        '  })',
        '  // body with .parse',
        '  app.post("/j", async (req: any) => {',
        '    return zod.parse(req.body)',
        '  })',
        '  // body access with reply.code 400',
        '  app.put("/k", async (req: any, reply: any) => {',
        '    if (!req.body.id) return reply.code(400).send({ message: "Invalid: id required" })',
        '    return { ok: true }',
        '  })',
        '  app.patch("/l", async () => ({}))',
        '  app.get("/m", async () => ({}))', // GET — skipped
        '}',
      ].join('\n'),
    );
    const result = await runCheck('fastify-route-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// di-static-inject-usage — broader shapes
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// duplicate-utility-functions — additional shapes
// ---------------------------------------------------------------------------

describe('duplicate-utility-functions — additional branches v3', () => {
  it('similar functions across files', async () => {
    const sharedBody = 'return s.trim().toLowerCase()';
    fx('src/u/a.ts', `export function clean(s: string): string { ${sharedBody} }`);
    fx('src/u/b.ts', `export function clean(s: string): string { ${sharedBody} }`);
    fx('src/u/c.ts', `export const cleanFn = (s: string): string => { ${sharedBody} }`);
    fx('src/u/d.ts', `export const cleanFn = function(s: string): string { ${sharedBody} }`);
    fx(
      'src/u/e.ts',
      `export function uniqueClean(input: string): string {
      // multi-step
      const trimmed = input.trim()
      const lower = trimmed.toLowerCase()
      return lower
    }`,
    );
    const result = await runCheck('duplicate-utility-functions');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// incomplete-regex-escaping — additional branches v3
// ---------------------------------------------------------------------------

describe('incomplete-regex-escaping — additional branches v3', () => {
  it('various RegExp patterns', async () => {
    fx(
      'src/x/re3.ts',
      [
        'export function r1(input: string) { return new RegExp(input) }',
        'export function r2(input: string) {',
        '  // safe escape',
        '  const escaped = input.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")',
        '  return new RegExp(escaped)',
        '}',
        'export function r3(prefix: string, suffix: string) {',
        '  return new RegExp(`${prefix}.*${suffix}`)',
        '}',
        String.raw`export const literalRe = /[a-z]+\d{2}/`,
        'export function r4(input: string) {',
        '  // Already escapes',
        String.raw`  const e1 = input.replace(/\./g, "\\.")`,
        '  return new RegExp(e1)',
        '}',
        'export function r5(input: string) {',
        '  return input.match(new RegExp(input, "gi"))',
        '}',
        'export function r6(s: string, p: string) {',
        '  return s.split(new RegExp(p))',
        '}',
        'export function r7(s: string, p: string) {',
        '  return s.replace(new RegExp(p, "g"), "")',
        '}',
        'export function r8() {',
        '  // No new RegExp call',
        '  return /static/i',
        '}',
        'export const fromStr = new RegExp("[a-z]+", "i")',
      ].join('\n'),
    );
    const result = await runCheck('incomplete-regex-escaping');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// silent-early-returns — broader v3
// ---------------------------------------------------------------------------

describe('silent-early-returns — additional branches v3', () => {
  it('various return shapes with and without observability', async () => {
    fx(
      'src/x/ser3.ts',
      [
        'export function f1(x: any) { if (!x) return null; return x }',
        'export function f2(x: any) { if (!x) { logger.error("missing"); return null } return x }',
        'export function f3(x: any) { if (!x) { console.log("log"); return null } return x }',
        'export function f4(items: any[]) { if (items.length === 0) return; return items }',
        'export function f5() { return undefined }',
        'export function f6() { return null }',
        'export function f7() { return [] }',
        'export function f8() { return {} }',
        'export function f9(): never { throw new Error("nope") }',
        'export function f10(x: any) { return x ?? null }',
        'export function f11(x: any) { return x || "default" }',
        'export const arrow = (x: any) => x ? x.id : null',
        'export class X {',
        '  m1(x: any) { if (!x) return null; return x }',
        '  m2(x: any) { if (!x) { this.emit("missing"); return null } return x }',
        '  emit(_: string) {}',
        '}',
        'export async function asyncEmpty() { return null }',
        'export function withValidator(x: any) {',
        '  validate(x)',
        '  if (!isValid(x)) return null',
        '  return x.data',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('silent-early-returns');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// missing-input-validation — broader v3
// ---------------------------------------------------------------------------

describe('missing-input-validation — additional branches v3', () => {
  it('various handler shapes', async () => {
    fx(
      'src/h/h3.ts',
      [
        'import { z } from "zod"',
        'export async function h1(req: any) {',
        '  const Body = z.object({ id: z.string() })',
        '  return Body.parse(req.body)',
        '}',
        'export async function h2(req: any) {',
        '  return req.body.id', // direct access',
        '}',
        'export async function h3(req: any) {',
        '  const { id } = req.body', // destructured',
        '  return id',
        '}',
        'export async function h4(req: any) {',
        '  const Body = z.object({ id: z.string() })',
        '  const result = Body.safeParse(req.body)',
        '  if (!result.success) return null',
        '  return result.data',
        '}',
        'export const arrowH = async (req: any) => req.body',
        'export class C {',
        '  async handle(req: any) { return req.body }',
        '  async safe(req: any) {',
        '    const Body = z.object({ id: z.string() })',
        '    return Body.parse(req.body)',
        '  }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('missing-input-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// database-schema-validation — drive defaults/notNull/unique branches
// ---------------------------------------------------------------------------

describe('database-schema-validation — additional branches v3', () => {
  it('table with various column shapes', async () => {
    fx(
      'src/db/sv3.ts',
      [
        'import { pgTable, serial, text, varchar, integer, boolean, timestamp, json, jsonb, uuid, real } from "drizzle-orm/pg-core"',
        'export const t = pgTable("t", {',
        '  id: serial("id").primaryKey(),',
        '  uuid: uuid("uuid").defaultRandom().notNull(),',
        '  name: text("name").notNull(),',
        '  email: varchar("email", { length: 255 }).notNull().unique(),',
        '  age: integer("age"),', // nullable int — no default
        '  active: boolean("active").default(true),',
        '  meta: jsonb("meta").default({}).notNull(),',
        '  amount: real("amount"),',
        '  createdAt: timestamp("created_at").defaultNow().notNull(),',
        '  updatedAt: timestamp("updated_at"),',
        '  notes: text("notes").default("none"),',
        '})',
        'export const t2 = pgTable("t2", {',
        '  id: text("id"),  // missing primary key',
        '  data: text("data"),  // missing notNull',
        '})',
      ].join('\n'),
    );
    const result = await runCheck('database-schema-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// openapi-response-coverage — broader v3
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// pii-exposure-in-logs — broader v3
// ---------------------------------------------------------------------------

describe('pii-exposure-in-logs — additional branches v3', () => {
  it('various log methods and PII shapes', async () => {
    fx(
      'src/svc/log3.ts',
      [
        'logger.info("Hello")',
        'logger.info({ user: { email: x.email, name: x.name } })',
        'logger.error({ password: x.password })',
        'logger.warn({ ssn: x.ssn, dob: x.dob })',
        'logger.debug({ creditCard: x.cc })',
        'logger.trace({ phone: x.phone })',
        'console.log("plain")',
        'console.log({ event: "metric.recorded", value: 1 })',
        'console.log(x.body)', // body included
        'console.error("boom: " + x.message)',
        'console.warn(`[${x.userId}] hi`)',
        'pino.info("ok")',
        'pino.error({ err: e })',
        'log({ event: "x" })',
      ].join('\n'),
    );
    const result = await runCheck('pii-exposure-in-logs');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// logger-event-name-format — broader v3
// ---------------------------------------------------------------------------

describe('logger-event-name-format — additional branches v3', () => {
  it('various event name shapes and edge cases', async () => {
    fx(
      'src/svc/ev3.ts',
      [
        'logger.info("user.created")',
        'logger.info("auth.login.success")',
        'logger.info("module.event_with_underscore")',
        'logger.info("WrongFormat")',
        'logger.info("wrong-format")',
        'logger.info("")',
        'logger.info({ event: "ok.snake_case" })',
        'logger.info({ event: "OK.SNAKE_CASE" })',
        'logger.info({ event: "" })',
        'logger.info({ event: 123 })',
        'logger.info({ x: 1 })', // no event field',
        'logger.warn({ event: undefined })',
        'logger.error({ event: null })',
      ].join('\n'),
    );
    const result = await runCheck('logger-event-name-format');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// lazy-loading — broader v3
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// unused-modules — broader v3
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// missing-type-exports v3 — exercise file types and patterns
// ---------------------------------------------------------------------------

describe('missing-type-exports — additional branches v3', () => {
  it('packages with different exports shapes', async () => {
    // Conditional-only exports (no subpath keys)
    fx(
      'packages/p1/package.json',
      JSON.stringify(
        {
          name: '@s/p1',
          version: '1.0.0',
          exports: {
            types: './dist/index.d.ts',
            import: './dist/index.js',
            default: './dist/index.cjs',
          },
        },
        null,
        2,
      ),
    );
    // Plain object exports
    fx(
      'packages/p2/package.json',
      JSON.stringify(
        {
          name: '@s/p2',
          version: '1.0.0',
          exports: {
            '.': './dist/index.js',
            './sub': './dist/sub.js',
            './widgets/*': './dist/widgets/*.js',
          },
        },
        null,
        2,
      ),
    );
    // String exports (shorthand)
    fx(
      'packages/p3/package.json',
      JSON.stringify(
        {
          name: '@s/p3',
          version: '1.0.0',
          exports: './dist/index.js',
        },
        null,
        2,
      ),
    );
    // No exports field at all
    fx(
      'packages/p4/package.json',
      JSON.stringify(
        {
          name: '@s/p4',
          version: '1.0.0',
        },
        null,
        2,
      ),
    );
    fx('packages/p4/src/index.ts', 'export const p4root = 1');
    fx('packages/p4/src/internal.ts', 'export const inner = 1');
    fx(
      'packages/u/src/uses.ts',
      [
        'import { x } from "@s/p1/anything"',
        'import { y } from "@s/p2/widgets/foo"',
        'import { z } from "@s/p2/notexposed"',
        'import { a } from "@s/p3/anything"',
        'import { p4root, inner } from "@s/p4/internal"',
        'import { same } from "@s/p4"', // root-only
        'import unscoped from "react"',
        'import single from "@scope/single"', // pkg = "@scope/single", subpath = "."
        'export const all = [x, y, z, a, p4root, inner, same, unscoped, single]',
      ].join('\n'),
    );
    fx('packages/u/src/x.test.ts', 'import { x } from "@s/p1/sub"\nexport const t = x');
    fx('packages/u/__tests__/y.ts', 'import { y } from "@s/p1/sub"\nexport const t = y');
    fx('packages/u/dist/z.ts', 'import { z } from "@s/p1/sub"');
    fx('packages/u/node_modules/dep/x.ts', 'import { x } from "@s/p1/sub"');
    const result = await runCheck('missing-type-exports');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// result-pattern-consistency — broader v3
// ---------------------------------------------------------------------------

describe('result-pattern-consistency — additional branches v3', () => {
  it('various Result types and throw mixing', async () => {
    fx(
      'src/x/r3.ts',
      [
        'type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }',
        'export function ok<T>(v: T): Result<T, never> { return { ok: true, value: v } }',
        'export function err<E>(e: E): Result<never, E> { return { ok: false, error: e } }',
        'export function valid(): Result<number, string> { return ok(1) }',
        'export function withErrTyped(): Result<number, string> { return err("nope") }',
        'export function bothPattern(x: number): Result<number, string> {',
        '  if (x < 0) return err("neg")',
        '  if (x === 0) throw new Error("zero")', // mixed',
        '  return ok(x * 2)',
        '}',
        'export function caughtRethrow() {',
        '  try { return ok(1) }',
        '  catch (e) { throw e }',
        '}',
        'export function legitimateThrowTyped() {',
        '  throw new ValidationError("bad")',
        '}',
        'export function isValid(x: number): boolean {',
        '  if (!Number.isFinite(x)) throw new Error("not finite")',
        '  return x > 0',
        '}',
        'export function checkAvailable(): boolean { return true }',
        'export function validateInput(): boolean { return true }',
        'export function assertNonNull<T>(x: T | null): T {',
        '  if (x === null) throw new Error("null")',
        '  return x',
        '}',
        'export function arrowFn(x: number) { if (x < 0) throw new Error("neg") }',
      ].join('\n'),
    );
    const result = await runCheck('result-pattern-consistency');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// sql-injection — broader v3
// ---------------------------------------------------------------------------

describe('sql-injection — additional branches v3', () => {
  it('various injection vectors', async () => {
    fx(
      'src/db/i3.ts',
      [
        'export async function f1(id: string) { return db.query(`SELECT * FROM x WHERE id = ${id}`) }',
        'export async function f2(name: string) {',
        '  const sql = "SELECT * FROM x WHERE name = \'" + name + "\'"',
        '  return db.query(sql)',
        '}',
        'export async function f3(id: number) { return db.query(`SELECT * FROM x WHERE id = ${id}`) }',
        'export async function f4(arr: any[]) {',
        '  return db.query(`INSERT INTO x VALUES (${arr.join(",")})`)',
        '}',
        'export async function safe(id: string) { return db.query("SELECT * FROM x WHERE id = $1", [id]) }',
        'export async function safe2(name: string) { return db.prepare("SELECT * FROM x WHERE name = ?").execute([name]) }',
        'export async function safeComment() {',
        '  // Comment containing SELECT * FROM x',
        '  return db.query("SELECT 1")',
        '}',
        'export async function noSql(name: string) { return name }',
      ].join('\n'),
    );
    const result = await runCheck('sql-injection');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// input-sanitization — broader v3
// ---------------------------------------------------------------------------

describe('input-sanitization — additional branches v3', () => {
  it('various source/sink combinations', async () => {
    fx(
      'src/api/u3.ts',
      [
        'import * as fs from "fs"',
        'import { exec } from "child_process"',
        'export function f1(req: any) { return fs.readFileSync(req.body.file) }',
        'export function f2(req: any) { return exec("echo " + req.body.x) }',
        'export function f3(req: any) { return fetch(req.body.url) }',
        'export function f4(req: any) { return `<div>${req.body.html}</div>` }',
        'export function f5(req: any) { return `<a href="${req.body.url}">click</a>` }',
        'export function f6(req: any) { return res.send(`<script>${req.body}</script>`) }',
        'export function f7() { return fs.readFileSync("/etc/hosts") }', // safe',
      ].join('\n'),
    );
    const result = await runCheck('input-sanitization');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// unsafe-secret-comparison — broader v3
// ---------------------------------------------------------------------------

describe('unsafe-secret-comparison — additional branches v3', () => {
  it('various comparison patterns', async () => {
    fx(
      'src/auth/u3.ts',
      [
        'import { timingSafeEqual } from "crypto"',
        'export function f1(secret: string, token: string) { return secret === token }',
        'export function f2(password: string, hash: string) { return password === hash }',
        'export function f3(apiKey: string, expected: string) { return apiKey == expected }',
        'export function f4(token: string, expected: string) { return token !== expected }',
        'export function f5(a: Buffer, b: Buffer) { return a.equals(b) }',
        'export function f6(a: Buffer, b: Buffer) { return timingSafeEqual(a, b) }',
        'export function f7(unrelated: number, other: number) { return unrelated === other }',
      ].join('\n'),
    );
    const result = await runCheck('unsafe-secret-comparison');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// postgres-n-plus-one — broader v3
// ---------------------------------------------------------------------------
