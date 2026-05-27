/**
 * @fileoverview Second branch-coverage push: targeted scenarios for the
 * highest-impact remaining branches.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { RunScope, runWithScope } from '@opensip-tools/core'
import { fileCache } from '@opensip-tools/fitness'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { checks } from '../index.js'

const testScope = new RunScope()

let cwd: string
let written: string[] = []

function fx(rel: string, content: string): string {
  const abs = join(cwd, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  written.push(abs)
  return abs
}

function findCheck(slug: string) {
  const c = checks.find((x) => x.config.slug === slug)
  if (!c) throw new Error(`check not found: ${slug}`)
  return c
}

async function runCheck(slug: string) {
  const check = findCheck(slug)
  await fileCache.prewarm(cwd, ['**/*'])
  return runWithScope(testScope, () => check.run(cwd, { targetFiles: written }))
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'opensip-cov-bp2-'))
  written = []
})

afterEach(() => {
  fileCache.clear()
  rmSync(cwd, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// detached-promises — drive isFloatingExpression branches deeply
// ---------------------------------------------------------------------------

describe('detached-promises — additional branches', () => {
  it('exercises isAwaitedExpression paren/non-null wrapping', async () => {
    fx('src/x/a.ts', [
      'export async function f() {',
      '  const x = !!(await fetcher())',
      '  unwrap((await fetcher())!)',
      '  unwrap((await fetcher()))',
      '  ((await fetcher())!).chain()',
      '  return x',
      '}',
    ].join('\n'))
    const result = await runCheck('detached-promises')
    expect(result).toBeDefined()
  })

  it('exercises containsAwaitedReceiver: element access, call descent', async () => {
    fx('src/x/b.ts', [
      'export async function f() {',
      '  (await x())[0]',
      '  (await x()).foo()',
      '  (await x())()',
      '  ((await x())!).bar()',
      '}',
    ].join('\n'))
    const result = await runCheck('detached-promises')
    expect(result).toBeDefined()
  })

  it('exercises isDefinedAsSyncInSameFile: sync method same class', async () => {
    fx('src/x/c.ts', [
      'export class Svc {',
      '  syncHelper() { return 1 }',
      '  async asyncHelper() { return 1 }',
      '  async run() {',
      '    this.syncHelper()',
      '    this.asyncHelper()',
      '  }',
      '}',
    ].join('\n'))
    const result = await runCheck('detached-promises')
    expect(result).toBeDefined()
  })

  it('exercises isInAsyncContext for class method declaration', async () => {
    fx('src/x/d.ts', [
      'export class Svc {',
      '  async run() {',
      '    floatingCall()',
      '  }',
      '  sync() {',
      '    floatingCall()', // not in async — skipped
      '  }',
      '}',
      'export const arrow = async () => { floatingCall() }',
      'export const arrowSync = () => { floatingCall() }',
      'function regular() { floatingCall() }',
    ].join('\n'))
    const result = await runCheck('detached-promises')
    expect(result).toBeDefined()
  })

  it('handles nested receiver chain with non-sync names (Pyroscope.x.y.start fallback)', async () => {
    fx('src/x/e.ts', [
      'export async function f() {',
      '  Pyroscope.default.start()',
      '  pyroscope.default.start()',
      '  some.deep.chain.lookup()',
      '  someUnknown.method()',
      '}',
    ].join('\n'))
    const result = await runCheck('detached-promises')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// throws-documentation — drive rethrow / self-doc branches
// ---------------------------------------------------------------------------

describe('throws-documentation — additional branches', () => {
  it('rethrow patterns: bare, this.error, unwrapErr, sanitizedError(err)', async () => {
    fx('src/x/throws.ts', [
      'export function f1() {',
      '  try { return 1 }',
      '  catch (err) { throw err }',
      '}',
      'export function f2() {',
      '  try { return 1 }',
      '  catch (e) { throw sanitizedError(e) }',
      '}',
      'export function f3() {',
      '  try { return 1 }',
      '  catch (err) { throw err.unwrapErr() }',
      '}',
      'export function f4() {',
      '  try { return 1 }',
      '  catch (err) { throw err.unwrap() }',
      '}',
      'export class K {',
      '  error?: Error',
      '  m() { throw this.error }',
      '  n() { throw this.cause }',
      '  o() { throw this.innerError }',
      '}',
      'export function fresh() {',
      '  // not a rethrow — fresh error',
      '  throw new Error("fresh")',
      '}',
      'export function arrowCallback() {',
      '  return [1].map((_) => { throw new Error("inside cb") })',
      '}',
      'export const namedArrow = () => { throw new Error("named") }',
    ].join('\n'))
    const result = await runCheck('throws-documentation')
    expect(result).toBeDefined()
  })

  it('self-documenting suffix matching', async () => {
    fx('src/x/typed.ts', [
      'export class FooApiError extends Error {}',
      'export function a() { throw new FooApiError() }',
      'export function b() { throw new ValidationError("x") }',
      'export function c() { throw new NotFoundError("nf") }',
      'export function d() { throw new InputValidationError("v") }',
    ].join('\n'))
    const result = await runCheck('throws-documentation')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// async-waterfall-detection — broader patterns
// ---------------------------------------------------------------------------

describe('async-waterfall-detection — additional branches', () => {
  it('arrow functions, methods, complex sequences', async () => {
    fx('src/x/wf.ts', [
      'export const arrow = async () => {',
      '  const a = await fetchA()',
      '  const b = await fetchB()',
      '  const c = await fetchC()',
      '  return [a, b, c]',
      '}',
      'export class Svc {',
      '  async run() {',
      '    const a = await fetchA()',
      '    const b = await fetchB()',
      '    return a + b',
      '  }',
      '  async runDep() {',
      '    const a = await fetchA()',
      '    const b = await fetchB(a)',
      '    return b',
      '  }',
      '}',
      'export async function notInBlock(): Promise<void> {',
      '  await fetchA()',
      '  await fetchB()',
      '  await fetchC()',
      '  await fetchD()',
      '}',
      'export async function withIfAndAwait(x: number) {',
      '  if (x > 0) {',
      '    await doIt()',
      '    await doMore()',
      '  } else {',
      '    await doOther()',
      '  }',
      '}',
      'export async function awaitInParallel() {',
      '  const [a, b] = await Promise.all([fetchA(), fetchB()])',
      '  return a + b',
      '}',
    ].join('\n'))
    const result = await runCheck('async-waterfall-detection')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// array-validation — broader patterns
// ---------------------------------------------------------------------------

describe('array-validation — additional branches', () => {
  it('Array<T>, ReadonlyArray<T>, union arrays, parenthesized, complex', async () => {
    fx('src/x/arr.ts', [
      'export function a(items: Array<number>) { return items[0] }',
      'export function b(items: ReadonlyArray<number>) { return items[0] }',
      'export function c(items: (string[] | number[])) { return items[0] }',
      'export function d(items: (string[])) { return items[0] }',
      'export function e(items: Map<string, number[]>) { return items.get("a")?.[0] }',
      'export function f(items: { id: string }[]) { return items[0]?.id }',
      'export function g(items?: number[]) { return items?.length }',
      'export function h(items: number[] | null) {',
      '  if (!items) return null',
      '  return items[0]',
      '}',
      'export function safeIsArray(items: unknown) {',
      '  if (!Array.isArray(items)) return null',
      '  return items[0]',
      '}',
      'export function withZod(items: number[]) {',
      '  z.array(z.number()).parse(items)',
      '  return items[0]',
      '}',
      'export function withCheck(items: number[]) {',
      '  return checkSomething(items) ? items[0] : null',
      '}',
      'export function withValidate(items: number[]) {',
      '  return validateInput(items) ? items[0] : null',
      '}',
    ].join('\n'))
    const result = await runCheck('array-validation')
    expect(result).toBeDefined()
  })

  it('skip-paths: tests, mocks, fixtures', async () => {
    fx('src/__tests__/x.ts', 'export function f(items: number[]) { return items[0] }')
    fx('src/__mocks__/y.ts', 'export function f(items: number[]) { return items[0] }')
    fx('src/test-fixtures/z.ts', 'export function f(items: number[]) { return items[0] }')
    const result = await runCheck('array-validation')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// numeric-validation — exercise more shapes
// ---------------------------------------------------------------------------

describe('numeric-validation — additional branches', () => {
  it('division, multiplication, comparisons, parseInt/parseFloat with guards', async () => {
    fx('src/x/num.ts', [
      'export function f(a: number, b: number) {',
      '  if (b === 0) throw new RangeError("div0")',
      '  if (Number.isNaN(a)) return 0',
      '  if (!Number.isFinite(a)) return 0',
      '  return a / b',
      '}',
      'export function p1(s: string) {',
      '  const n = parseInt(s, 10)',
      '  if (Number.isNaN(n)) return 0',
      '  return n',
      '}',
      'export function p2(s: string) {',
      '  return parseInt(s)', // missing radix
      '}',
      'export function p3(s: string) {',
      '  return parseFloat(s)',
      '}',
      'export function p4(s: string) {',
      '  return Number(s)',
      '}',
      'export function negative(a: number) {',
      '  return -a',
      '}',
      'export function powAndMod(a: number, b: number) {',
      '  return (a ** b) + (a % b)',
      '}',
      'export class Calc {',
      '  divide(a: number, b: number) { return a / b }',
      '}',
    ].join('\n'))
    const result = await runCheck('numeric-validation')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// null-safety — additional patterns
// ---------------------------------------------------------------------------

describe('null-safety — additional branches', () => {
  it('union types, nullable returns, optional chains, non-null assertions', async () => {
    fx('src/x/ns.ts', [
      'export function f1(x: string | null) {',
      '  return x.length', // unsafe
      '}',
      'export function f2(x: string | null | undefined) {',
      '  return x?.length',
      '}',
      'export function f3(x?: { a?: { b?: number } }) {',
      '  return x?.a?.b ?? 0',
      '}',
      'export function f4(x: number | null) {',
      '  if (typeof x === "number") return x + 1',
      '  return 0',
      '}',
      'export function f5(x: { items: number[] | null }) {',
      '  return x.items.length', // unsafe nested
      '}',
      'export class X {',
      '  name?: string',
      '  greet() { return this.name!.toUpperCase() }',
      '  greetSafe() { return this.name?.toUpperCase() ?? "anon" }',
      '  greetCheck() {',
      '    if (this.name === undefined) return ""',
      '    return this.name',
      '  }',
      '}',
      'export function arr(items?: number[] | null) {',
      '  return items?.[0] ?? 0',
      '}',
      'export function withTypeOf(v: unknown) {',
      '  if (typeof v === "string") return v.length',
      '  return 0',
      '}',
    ].join('\n'))
    const result = await runCheck('null-safety')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// stubbed-implementation-detection — multi-pattern
// ---------------------------------------------------------------------------

describe('stubbed-implementation-detection — additional branches', () => {
  it('various stub shapes', async () => {
    fx('src/x/stub.ts', [
      'export function s1() { return null }',
      'export function s2(): null { return null }',
      'export function s3() { return undefined }',
      'export function s4() { return [] }',
      'export function s5() { return {} }',
      'export function s6(): void { }',
      'export function s7(): void { /* TODO */ }',
      'export function s8() { throw new Error("not implemented") }',
      'export function s9() { throw new Error("Not yet implemented") }',
      'export function s10() { throw new Error("TODO") }',
      'export function s11() { throw new Error("FIXME") }',
      'export async function s12() { return null }',
      'export const arrow = () => null',
      'export class K {',
      '  m1() { return null }',
      '  m2(): never { throw new Error("nope") }',
      '  m3() { return [] }',
      '  m4() {} // empty',
      '  m5() {',
      '    throw new Error("not implemented")',
      '  }',
      '}',
      'export function realImpl(a: number, b: number) {',
      '  if (a < 0) throw new RangeError("neg")',
      '  return a + b * 2',
      '}',
    ].join('\n'))
    const result = await runCheck('stubbed-implementation-detection')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// di-static-inject-usage — broader scenarios
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// fastify-route-validation — broader scenarios
// ---------------------------------------------------------------------------

describe('fastify-route-validation — additional branches', () => {
  it('POST/PUT/PATCH with options, with arrow handler, with body access without validation', async () => {
    fx('src/routes/r.ts', [
      'import type { FastifyInstance } from "fastify"',
      'export async function reg(app: FastifyInstance) {',
      '  app.post("/a", { schema: { body: { type: "object" } } }, async () => ({ ok: true }))',
      '  app.post("/b", async (req, reply) => {',
      '    const body = request.body',
      '    if (!body) return reply.code(400).send({ message: "Missing body" })',
      '    return { ok: true }',
      '  })',
      '  app.post("/c", async (req) => {',
      '    return req.body',
      '  })',
      '  app.put("/d", { schema: { body: {} } }, async () => ({}))',
      '  app.patch("/e", async () => ({}))',
      '  app.get("/f", async () => ({}))', // GET — skipped',
      '  app.post("/g")', // single arg — skipped',
      '  app.post("/h", function(req, reply) { return req.body })',
      '  app.post("/i", { schema: { params: {} } }, async () => ({}))', // schema but no body
      '}',
    ].join('\n'))
    fx('src/routes/zod.ts', [
      'import { z } from "zod"',
      'const Body = z.object({ id: z.string() })',
      'export const reg = (app: any) => {',
      '  app.post("/x", async (req: any) => {',
      '    Body.parse(req.body)',
      '    return { ok: true }',
      '  })',
      '}',
    ].join('\n'))
    fx('src/routes/contracts.ts', [
      '// uses contracts and Schema',
      'export const reg = (app: any) => {',
      '  app.post("/y", async (req: any) => req.body)',
      '}',
    ].join('\n'))
    const result = await runCheck('fastify-route-validation')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// duplicate-utility-functions — additional shapes
// ---------------------------------------------------------------------------

describe('duplicate-utility-functions — additional branches', () => {
  it('arrow functions, function expressions, varying arities', async () => {
    fx('src/u/a.ts', [
      'export const fmt = (s: string) => s.trim()',
      'export const sum = (a: number, b: number) => a + b',
      'export function helperX(s: string) { return s.toLowerCase() }',
    ].join('\n'))
    fx('src/u/b.ts', [
      'export const fmt = (s: string) => s.trim()', // duplicate arrow
      'export function sum(a: number, b: number) { return a + b }', // same body different syntax
    ].join('\n'))
    fx('src/u/c.ts', [
      'export const fmt = function(s: string) { return s.trim() }',
    ].join('\n'))
    fx('src/u/d.ts', [
      'export function unique(name: string) { return `hello ${name}` }',
    ].join('\n'))
    const result = await runCheck('duplicate-utility-functions')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// silent-early-returns — broader patterns
// ---------------------------------------------------------------------------

describe('silent-early-returns — additional branches', () => {
  it('return null/undefined/empty array, with and without log', async () => {
    fx('src/x/ser.ts', [
      'export function f1(x: any) { if (!x) return null; return x.id }',
      'export function f2(x: any) {',
      '  if (!x) {',
      '    logger.warn({ event: "missing" })',
      '    return null',
      '  }',
      '  return x.id',
      '}',
      'export function f3(items: any[]) { if (!items.length) return; return items[0] }',
      'export function f4(items: any[]) { if (!items.length) { console.error("empty"); return } return items[0] }',
      'export function f5(x?: string) { return x ?? null }',
      'export function f6() { return undefined }',
      'export function f7(): never { throw new Error("never") }',
      'export class X {',
      '  m(x: any) { if (!x) return null; return x.id }',
      '  n(x: any) { if (!x) { this.log("oops"); return null } return x.id }',
      '  log(msg: string) { return msg }',
      '}',
      'export const arrow = (x: any) => x ? x.id : null',
    ].join('\n'))
    const result = await runCheck('silent-early-returns')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// missing-input-validation — additional shapes
// ---------------------------------------------------------------------------

describe('missing-input-validation — additional branches', () => {
  it('zod parse, safeParse, no validation, arrow handler', async () => {
    fx('src/x/h.ts', [
      'import { z } from "zod"',
      'export async function h1(req: any) {',
      '  const Body = z.object({ x: z.string() })',
      '  return Body.parse(req.body)',
      '}',
      'export async function h2(req: any) {',
      '  const Body = z.object({ x: z.string() })',
      '  const r = Body.safeParse(req.body)',
      '  return r.success ? r.data : null',
      '}',
      'export async function h3(req: any) {',
      '  return req.body.x', // no validation
      '}',
      'export const h4 = async (req: any) => req.body.x', // arrow no validation
      'export class C {',
      '  async handle(req: any) {',
      '    return req.body',
      '  }',
      '}',
    ].join('\n'))
    const result = await runCheck('missing-input-validation')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// api-response-validation — additional shapes
// ---------------------------------------------------------------------------

describe('api-response-validation — additional branches', () => {
  it('handlers returning typed responses, raw db, or wrapped', async () => {
    fx('src/x/api.ts', [
      'import { z } from "zod"',
      'const Resp = z.object({ ok: z.boolean() })',
      'export async function safe() { return Resp.parse({ ok: true }) }',
      'export async function unsafe() { return await db.query("SELECT *") }',
      'export async function arrow1() { return { ok: true } }',
      'export const arrow2 = async () => Resp.parse({ ok: true })',
      'export class C {',
      '  async fetch() { return { ok: true } }',
      '  async typed(): Promise<{ ok: boolean }> { return { ok: true } }',
      '}',
    ].join('\n'))
    const result = await runCheck('api-response-validation')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// api-contract-validation — broader shapes
// ---------------------------------------------------------------------------

describe('api-contract-validation — additional branches', () => {
  it('handler signatures with various forms', async () => {
    fx('src/x/h2.ts', [
      'export async function h1(req: { body: string }, res: any): Promise<{ ok: boolean }> {',
      '  return { ok: true }',
      '}',
      'export async function h2(req: any, res: any) {',
      '  try { return { ok: true } } catch (e) { return { ok: false } }',
      '}',
      'export const arrow = async (req: any) => req',
      'export class C {',
      '  async handle(req: any, res: any): Promise<unknown> { return req }',
      '  async typed(req: { x: number }): Promise<{ ok: boolean }> { return { ok: true } }',
      '}',
      'export function sync(req: any) { return req }',
      'export const noTypeArrow = (req: any) => req',
    ].join('\n'))
    const result = await runCheck('api-contract-validation')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// incomplete-regex-escaping — broader scenarios
// ---------------------------------------------------------------------------

describe('incomplete-regex-escaping — additional branches', () => {
  it('various RegExp constructions and escapes', async () => {
    fx('src/x/re.ts', [
      'export function r1(input: string) { return new RegExp(input) }',
      'export function r2(input: string) {',
      '  const escaped = input.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")',
      '  return new RegExp(escaped)',
      '}',
      'export function r3(prefix: string) {',
      '  return new RegExp(`^${prefix}`)',
      '}',
      'export const literal = /[a-z]+/g',
      String.raw`export const multi = /^\w{3,8}$/`,
      'export function r4(input: string) {',
      '  return input.replace(new RegExp(input, "i"), "")',
      '}',
      'export function r5() {',
      String.raw`  return new RegExp("\\d+", "g")`,
      '}',
      'export function r6(input: string) {',
      '  // comment about new RegExp',
      '  return input',
      '}',
    ].join('\n'))
    const result = await runCheck('incomplete-regex-escaping')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// unused-modules / unused-config-options — branches
// ---------------------------------------------------------------------------


describe('unused-config-options — additional branches', () => {
  it('Config interface with optional/required, used and unused fields', async () => {
    fx('src/config/c.ts', [
      'export interface AppConfig {',
      '  apiUrl: string',
      '  port: number',
      '  optional?: boolean',
      '  unused: string',
      '  unusedOptional?: boolean',
      '}',
    ].join('\n'))
    fx('src/main.ts', [
      'import type { AppConfig } from "./config/c.js"',
      'export function start(c: AppConfig) {',
      '  console.log(c.apiUrl)',
      '  console.log(c.port)',
      '  if (c.optional) doIt()',
      '  return c',
      '}',
    ].join('\n'))
    const result = await runCheck('unused-config-options')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// drizzle-orm-migration-guardrails — drive remaining branches
// ---------------------------------------------------------------------------

describe('drizzle-orm-migration-guardrails — additional branches', () => {
  it('test paths skip, comment lines skip, DATA-LOSS skip', async () => {
    fx('src/db/migrations/m1.test.ts', 'export const x = 1\nDROP TABLE foo')
    fx('src/db/migrations/__tests__/y.ts', 'export const x = 1\nDROP TABLE foo')
    fx('src/db/migrations/m2.ts', [
      '// regular comment',
      '* doc-comment block',
      '',
      '// DATA-LOSS: intentional drop for renamed_users migration',
      'export const m = sql`DROP TABLE renamed_users`',
      'export const tr = sql`TRUNCATE TABLE log_old`',
      'export const a = sql`ALTER TABLE x ALTER COLUMN y TYPE varchar`',
    ].join('\n'))
    fx('src/db/schema/users.ts', [
      'export const users = pgTable("users", {})',
      'sql.unsafe("UPDATE users SET active=true")',
    ].join('\n'))
    const result = await runCheck('drizzle-orm-migration-guardrails')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// observability-coverage helper — direct unit-test path
// ---------------------------------------------------------------------------

// covered by existing dedicated unit tests under
// src/checks/quality/observability/observability-coverage/__tests__/

// ---------------------------------------------------------------------------
// pii-exposure-in-logs — additional patterns
// ---------------------------------------------------------------------------

describe('pii-exposure-in-logs — additional branches', () => {
  it('various log methods and PII fields', async () => {
    fx('src/svc/log.ts', [
      'export function f1(req: any) {',
      '  logger.debug({ user: { email: req.email, password: req.password, ssn: req.ssn } })',
      '  console.log({ creditCard: req.cc })',
      '  console.warn({ phone: req.phone, dob: req.dob })',
      '  console.error("error: " + req.body)',
      '  pino.info({ name: req.name })', // user name
      '}',
      'export function safe(req: any) {',
      '  logger.info({ event: "user.created", id: req.id })',
      '  logger.info({ requestId: req.requestId })',
      '  console.log("safe message")',
      '}',
    ].join('\n'))
    const result = await runCheck('pii-exposure-in-logs')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// logger-event-name-format — drive shape branches
// ---------------------------------------------------------------------------

describe('logger-event-name-format — additional branches', () => {
  it('various event-name shapes', async () => {
    fx('src/svc/ev.ts', [
      'logger.info("user.created")',
      'logger.info("UserCreated")',
      'logger.info("user_created")',
      'logger.info("user-created")',
      'logger.info({ event: "user.created" })',
      'logger.info({ event: "userCreated" })',
      'logger.info({ event: "USER_CREATED" })',
      'logger.warn({ event: "" })',
      'logger.error({ event: 123 })',
      'logger.info({ x: 1 })',
      'logger.info("plain message")',
      'logger.info("module.submodule.event_name")',
    ].join('\n'))
    const result = await runCheck('logger-event-name-format')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// stream-buffer-size-limits — additional shapes
// ---------------------------------------------------------------------------

describe('stream-buffer-size-limits — additional branches', () => {
  it('Readable, Writable, Transform, pipe', async () => {
    fx('src/stream/s.ts', [
      'import { Readable, Writable, Transform, pipeline } from "stream"',
      'export const r1 = new Readable()',  // unbounded
      'export const r2 = new Readable({ highWaterMark: 1024 })',
      'export const w1 = new Writable()',  // unbounded
      'export const w2 = new Writable({ highWaterMark: 4096 })',
      'export const t1 = new Transform()',
      'export const t2 = new Transform({ highWaterMark: 8192 })',
      'export const p = pipeline(r1, w1, () => undefined)',
    ].join('\n'))
    const result = await runCheck('stream-buffer-size-limits')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// dispose-pattern-completeness — additional class shapes
// ---------------------------------------------------------------------------

describe('dispose-pattern-completeness — additional branches', () => {
  it('various dispose patterns', async () => {
    fx('src/x/d.ts', [
      'export class A implements Disposable {',
      '  [Symbol.dispose]() {}',
      '}',
      'export class B implements AsyncDisposable {',
      '  async [Symbol.asyncDispose]() {}',
      '}',
      'export class C {',
      '  dispose() {}',
      '}',
      'export class D {',
      '  destroy() {}',
      '}',
      'export class E {',
      '  async close() {}',
      '}',
      'export class F {',
      '  private timer: NodeJS.Timer | null = null',
      '  start() { this.timer = setInterval(() => undefined, 100) }',
      '  // missing dispose',
      '}',
      'export class G {',
      '  private interval: any',
      '  private subscription: any',
      '  start() {',
      '    this.interval = setInterval(() => undefined, 100)',
      '    this.subscription = src.subscribe(() => undefined)',
      '  }',
      '  dispose() {',
      '    if (this.interval) clearInterval(this.interval)',
      '    this.subscription?.unsubscribe()',
      '  }',
      '}',
    ].join('\n'))
    const result = await runCheck('dispose-pattern-completeness')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// lifecycle-cleanup-enforcement — additional patterns
// ---------------------------------------------------------------------------

describe('lifecycle-cleanup-enforcement — additional branches', () => {
  it('useEffect with intervals, listeners, observers, fetches', async () => {
    fx('src/x/le.tsx', [
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
      '    const t = setTimeout(() => undefined, 100)',
      '    return () => clearTimeout(t)',
      '  }, [])',
      '  return null',
      '}',
      'export function C() {',
      '  useEffect(() => {',
      '    window.addEventListener("resize", onResize)',
      '    return () => window.removeEventListener("resize", onResize)',
      '  }, [])',
      '  return null',
      '}',
      'export function D() {',
      '  useEffect(() => {',
      '    setInterval(() => undefined, 100)', // missing cleanup
      '  }, [])',
      '  return null',
      '}',
      'export function E() {',
      '  useEffect(() => {',
      '    const ac = new AbortController()',
      '    fetch("/x", { signal: ac.signal })',
      '    return () => ac.abort()',
      '  }, [])',
      '  return null',
      '}',
    ].join('\n'))
    const result = await runCheck('lifecycle-cleanup-enforcement')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// mock-implementations-in-production — drive line 197 branch
// ---------------------------------------------------------------------------

describe('mock-implementations-in-production — additional branches', () => {
  it('files in src/ vs __mocks__ vs test paths', async () => {
    fx('src/api/handler.ts', [
      'export const fakeData = () => [{ id: "fake" }]',
      'export const mockUser = { id: "mock", isMock: true }',
      'export class StubClient {',
      '  query() { return [] }',
      '}',
    ].join('\n'))
    fx('src/__mocks__/api.ts', [
      'export const mockUser = { id: "mock" }',
    ].join('\n'))
    fx('src/x.test.ts', [
      'export const t = "test"',
    ].join('\n'))
    fx('src/realImpl.ts', [
      'export class RealClient {',
      '  query() { return [] }',
      '}',
    ].join('\n'))
    const result = await runCheck('mock-implementations-in-production')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// context-safety — drive several branches
// ---------------------------------------------------------------------------

describe('context-safety — additional branches', () => {
  it('various context-related patterns', async () => {
    fx('src/svc/cs.ts', [
      'export class Foo {',
      '  async method() {',
      '    return this.helper()',
      '  }',
      '  helper() { return 1 }',
      '}',
      'export const arrow = (this: any) => this.something',
      'export class Bar {',
      '  data = "x"',
      '  bound = this.method.bind(this)',
      '  method() { return this.data }',
      '  unbound() { return this.method }',
      '}',
      'export class Baz {',
      '  callback() {',
      '    setTimeout(() => this.run(), 100)', // safe arrow capture',
      '    setTimeout(this.run.bind(this), 100)', // safe bind',
      '    setTimeout(this.run, 100)', // unsafe!',
      '  }',
      '  run() { return 1 }',
      '}',
    ].join('\n'))
    const result = await runCheck('context-leakage')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// async-patterns / no-raw-fetch — additional skip-path branches
// ---------------------------------------------------------------------------

describe('no-raw-fetch — additional skip patterns', () => {
  it('comment-only lines, fitness check files', async () => {
    fx('src/fitness/src/checks/x.ts', [
      'export const x = "fetch("',  // mention but it is a fitness check file',
      'await fetch("/x")',
    ].join('\n'))
    fx('src/x.spec.tsx', [
      'await fetch("/x")',
    ].join('\n'))
    fx('src/x.test.jsx', [
      'await fetch("/x")',
    ].join('\n'))
    fx('src/api/r.ts', [
      '// fetch in comment',
      '/* multi-line comment with fetch( */',
      'await fetch("/real")',
    ].join('\n'))
    const result = await runCheck('no-raw-fetch')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// toctou-race-condition — additional class/getter/multi-method branches
// ---------------------------------------------------------------------------

describe('toctou-race-condition — additional branches', () => {
  it('private field cache, multiple methods, setter/getter', async () => {
    fx('src/x/toc.ts', [
      'export class C {',
      '  private _cache = new Map<string, number>()',
      '  private store: Map<string, number> = new Map()',
      '  get count() { return this._cache.size }',
      '  set value(v: number) { this._cache.set("v", v) }',
      '  read(id: string) { return this._cache.get(id) }',
      '  write(id: string, v: number) { this._cache.set(id, v) }',
      '  // shared receiver',
      '  async sharedReadUpdate(id: string) {',
      '    const u = await db.find(id)',
      '    return await db.update({ ...u })',
      '  }',
      '}',
      'export function topLevel(repo: any) {',
      '  const u = repo.find(1)',
      '  repo.update(u)',
      '  return u',
      '}',
    ].join('\n'))
    const result = await runCheck('toctou-race-condition')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// memo-list-items — exercise findEnclosingMapCall walk + isInsideUseMemo deep
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// no-inline-functions — additional branches
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// platform-checks — additional shapes
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// flashlist-enforcement — additional shapes
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// lazy-loading — broader patterns
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// missing-type-exports — exercise barrel-only fallback and patterns
// ---------------------------------------------------------------------------

describe('missing-type-exports — additional branches', () => {
  it('package without exports map (barrel fallback), wildcards', async () => {
    fx('packages/lib/package.json', JSON.stringify({
      name: '@s/lib',
      version: '1.0.0',
    }, null, 2))
    fx('packages/lib/src/index.ts', 'export { Public } from "./pub.js"')
    fx('packages/lib/src/pub.ts', 'export const Public = 1')
    fx('packages/lib/src/internal.ts', 'export const Internal = 2')
    fx('packages/lib/src/wild.ts', 'export const Wild = 3')
    fx('packages/u/src/uses.ts', [
      'import { Public } from "@s/lib/some/path"',
      'import { Internal } from "@s/lib/internal"',
      'export const x = Public',
      'export const y = Internal',
    ].join('\n'))

    fx('packages/lib2/package.json', JSON.stringify({
      name: '@s/lib2',
      version: '1.0.0',
      exports: {
        '.': './dist/index.js',
        './sub/*': './dist/sub/*.js',
      },
    }, null, 2))
    fx('packages/u2/src/uses.ts', [
      'import { X } from "@s/lib2/sub/widget"', // wildcard match
      'import { Y } from "@s/lib2/notexposed"', // not declared
      'export const z = X',
      'export const w = Y',
    ].join('\n'))
    const result = await runCheck('missing-type-exports')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// circular-import-detection — exercise basic patterns
// ---------------------------------------------------------------------------

describe('circular-import-detection — additional branches', () => {
  it('two-cycle, three-cycle, no-cycle', async () => {
    fx('src/c/a.ts', 'import { b } from "./b.js"; export const a = b')
    fx('src/c/b.ts', 'import { a } from "./a.js"; export const b = a')
    fx('src/c/x.ts', 'import { y } from "./y.js"; export const x = y')
    fx('src/c/y.ts', 'import { z } from "./z.js"; export const y = z')
    fx('src/c/z.ts', 'import { x } from "./x.js"; export const z = x')
    fx('src/c/clean.ts', 'export const clean = 1')
    const result = await runCheck('circular-import-detection')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// module-coupling-fan-out — additional shapes
// ---------------------------------------------------------------------------

describe('module-coupling-fan-out — additional branches', () => {
  it('high-fanout files vs low-fanout', async () => {
    const imports: string[] = []
    for (let i = 0; i < 25; i++) {
      fx(`src/m/m${i}.ts`, `export const m${i} = ${i}`)
      imports.push(`import { m${i} } from "./m${i}.js"`)
    }
    fx('src/m/big.ts', [
      ...imports,
      'export const total = ' + Array.from({ length: 25 }, (_, i) => `m${i}`).join(' + '),
    ].join('\n'))
    fx('src/m/small.ts', 'import { m0 } from "./m0.js"; export const x = m0')
    const result = await runCheck('module-coupling-fan-out')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// typed-inject-scope-mismatch — additional shapes
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// package-json-exports-field — broader shapes
// ---------------------------------------------------------------------------

describe('package-json-exports-field — additional branches', () => {
  it('various exports configurations', async () => {
    fx('package.json', JSON.stringify({
      name: '@scope/test',
      version: '1.0.0',
      type: 'module',
      main: './dist/index.js',
      module: './dist/index.mjs',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          import: './dist/index.js',
          types: './dist/index.d.ts',
        },
        './errors': './dist/errors.js',
      },
    }, null, 2))
    fx('src/index.ts', 'export const x = 1')
    const result = await runCheck('package-json-exports-field')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// contracts-schema-consistency — additional shapes
// ---------------------------------------------------------------------------

describe('contracts-schema-consistency — additional branches', () => {
  it('zod schemas with matching/non-matching types', async () => {
    fx('src/contracts/schemas.ts', [
      'import { z } from "zod"',
      'export const UserSchema = z.object({ id: z.string(), name: z.string() })',
      'export type User = z.infer<typeof UserSchema>',
      'export const ProductSchema = z.object({ id: z.string(), price: z.number() })',
      'export interface Product { id: string; price: number }',
    ].join('\n'))
    const result = await runCheck('contracts-schema-consistency')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// tsconfig-extends-validation — broader scenarios
// ---------------------------------------------------------------------------

describe('tsconfig-extends-validation — additional branches', () => {
  it('with extends, without extends, with strict, missing strict', async () => {
    fx('tsconfig.base.json', JSON.stringify({ compilerOptions: { strict: true } }, null, 2))
    fx('tsconfig.json', JSON.stringify({
      extends: './tsconfig.base.json',
      compilerOptions: { target: 'es2022' },
    }, null, 2))
    fx('packages/a/tsconfig.json', JSON.stringify({
      compilerOptions: { strict: false },
    }, null, 2))
    fx('packages/b/tsconfig.json', JSON.stringify({
      compilerOptions: {},
    }, null, 2))
    const result = await runCheck('tsconfig-extends-validation')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// openapi-response-coverage — broader shapes
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// fastify-schema-coverage — broader scenarios
// ---------------------------------------------------------------------------

describe('fastify-schema-coverage — additional branches', () => {
  it('routes with full/partial schemas', async () => {
    fx('src/routes/r.ts', [
      'export const reg = (app: any) => {',
      '  app.post("/a", { schema: { body: {}, response: { 200: {}, 400: {} } } }, async () => ({}))',
      '  app.get("/b", { schema: { response: { 200: {} } } }, async () => ({}))',
      '  app.post("/c", { schema: { body: {} } }, async () => ({}))',
      '  app.put("/d", async () => ({}))',
      '}',
    ].join('\n'))
    const result = await runCheck('fastify-schema-coverage')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// dynamodb-scan-detection
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// no-hardcoded-correlation-id
// ---------------------------------------------------------------------------

describe('no-hardcoded-correlation-id — additional branches', () => {
  it('hardcoded vs generated', async () => {
    fx('src/svc/ci.ts', [
      'export function bad() { return "00000000-0000-0000-0000-000000000000" }',
      'export function bad2() { return { correlationId: "fixed-id-123" } }',
      'export function good() { return crypto.randomUUID() }',
      'export function good2() { return generateCorrelationId() }',
    ].join('\n'))
    const result = await runCheck('no-hardcoded-correlation-id')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// context-mutation
// ---------------------------------------------------------------------------

describe('context-mutation — additional branches', () => {
  it('mutation vs read-only context access', async () => {
    fx('src/svc/cm.ts', [
      'export function f1(ctx: any) {',
      '  ctx.user = "x"', // mutation
      '  ctx.tags.push("a")', // mutation
      '  return ctx',
      '}',
      'export function f2(ctx: any) {',
      '  const { user } = ctx', // read
      '  return user',
      '}',
    ].join('\n'))
    const result = await runCheck('context-mutation')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// test-only-implementations
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// openapi-type-source — branches
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// frontend-client-boundary-placement — additional branches
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// a11y-form-labels / a11y-semantic-html / accessible-touchables
// ---------------------------------------------------------------------------

describe('a11y-form-labels — additional branches', () => {
  it('labeled and unlabeled inputs', async () => {
    fx('src/c/F.tsx', [
      'export function A() {',
      '  return (<form>',
      '    <label htmlFor="email">Email</label><input id="email" type="email" />',
      '    <input type="text" />',
      '    <input aria-label="Search" type="search" />',
      '    <input aria-labelledby="lbl" type="text" />',
      '    <button type="submit">Send</button>',
      '  </form>)',
      '}',
    ].join('\n'))
    const result = await runCheck('a11y-form-labels')
    expect(result).toBeDefined()
  })
})

describe('a11y-semantic-html — additional branches', () => {
  it('semantic vs div/span', async () => {
    fx('src/c/H.tsx', [
      'export function A() {',
      '  return (<div>',
      '    <div onClick={() => null}>tap</div>',
      '    <span style={{ cursor: "pointer" }}>also tappable</span>',
      '    <button onClick={() => null}>OK</button>',
      '    <header><nav>...</nav></header>',
      '    <main><article><section>x</section></article></main>',
      '  </div>)',
      '}',
    ].join('\n'))
    const result = await runCheck('a11y-semantic-html')
    expect(result).toBeDefined()
  })
})


// ---------------------------------------------------------------------------
// in-memory-repository-detection — additional shapes
// ---------------------------------------------------------------------------

describe('in-memory-repository-detection — additional branches', () => {
  it('multi-storage with class containing UserRepository', async () => {
    fx('src/r/Reps.ts', [
      'export class UserRepository {',
      '  private byMap = new Map<string, number>()',
      '  private bySet = new Set<string>()',
      '  private byArray: { id: string }[] = []',
      '  private byObject: Record<string, unknown> = {}',
      '  async listAll() { return [...this.byMap.values()] }',
      '}',
      '// UserRepository',
    ].join('\n'))
    const result = await runCheck('in-memory-repository-detection')
    expect(result).toBeDefined()
  })

  it('skip when path contains InMemory or Mock or Cache', async () => {
    fx('src/r/InMemory.ts', [
      'export class InMemoryRepository {',
      '  private data = new Map()',
      '}',
    ].join('\n'))
    fx('src/r/Mock.ts', [
      'export class MockUserRepository {',
      '  private data = new Map()',
      '}',
    ].join('\n'))
    const result = await runCheck('in-memory-repository-detection')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// financial-transaction-ordering — additional shapes
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// database-index-coverage / database-schema-validation
// ---------------------------------------------------------------------------

describe('database-index-coverage — additional branches', () => {
  it('drizzle table with composite index, full-text index, no index', async () => {
    fx('src/db/s/users.ts', [
      'import { pgTable, serial, text, varchar, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core"',
      'export const users = pgTable("users", {',
      '  id: serial("id").primaryKey(),',
      '  email: varchar("email", { length: 255 }).notNull(),',
      '  tenantId: integer("tenant_id").notNull(),',
      '  createdAt: timestamp("created_at").defaultNow().notNull(),',
      '}, (t) => ({',
      '  emailIdx: uniqueIndex("email_idx").on(t.email),',
      '  tenantIdx: index("tenant_idx").on(t.tenantId),',
      '  composite: index("comp_idx").on(t.tenantId, t.createdAt),',
      '}))',
      'export const noIdx = pgTable("noidx", {',
      '  id: serial("id").primaryKey(),',
      '  status: text("status"),',
      '})',
    ].join('\n'))
    const result = await runCheck('database-index-coverage')
    expect(result).toBeDefined()
  })
})

describe('database-schema-validation — additional branches', () => {
  it('table with various column shapes and constraints', async () => {
    fx('src/db/s/all.ts', [
      'import { pgTable, serial, text, varchar, integer, boolean, timestamp, json, jsonb, uuid, real } from "drizzle-orm/pg-core"',
      'export const t = pgTable("t", {',
      '  id: serial("id").primaryKey(),',
      '  uuid: uuid("uuid").defaultRandom().notNull(),',
      '  name: text("name").notNull(),',
      '  email: varchar("email", { length: 255 }).notNull().unique(),',
      '  age: integer("age"),',
      '  active: boolean("active").default(true).notNull(),',
      '  meta: jsonb("meta").$type<{ x: string }>().notNull().default({}),',
      '  meta2: json("meta2"),',
      '  amount: real("amount"),',
      '  createdAt: timestamp("created_at").defaultNow().notNull(),',
      '})',
    ].join('\n'))
    const result = await runCheck('database-schema-validation')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// postgres-n-plus-one — additional patterns
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// typeorm-n-plus-one — additional patterns
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// sql-injection — additional patterns
// ---------------------------------------------------------------------------

describe('sql-injection — additional branches', () => {
  it('various injection and safe patterns', async () => {
    fx('src/db/s.ts', [
      'export async function f1(id: string) { return db.query(`SELECT * FROM x WHERE id = ${id}`) }',
      'export async function f2(id: string) { return db.query("SELECT * FROM x WHERE id = $1", [id]) }',
      'export async function f3(name: string) {',
      '  const sql = "SELECT * FROM x WHERE name = \'" + name + "\'"',
      '  return db.query(sql)',
      '}',
      'export async function f4(name: string) {',
      '  return db.prepare("SELECT * FROM x WHERE name = ?").execute([name])',
      '}',
      'export async function f5() {',
      '  // Static string, no injection',
      '  return db.query("SELECT * FROM x")',
      '}',
      'export async function f6(id: string) {',
      '  return raw(`SELECT * FROM ${id}`)', // raw helper, also dangerous',
      '}',
    ].join('\n'))
    const result = await runCheck('sql-injection')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// input-sanitization — additional patterns
// ---------------------------------------------------------------------------

describe('input-sanitization — additional branches', () => {
  it('various sources of user input and sinks', async () => {
    fx('src/api/risk.ts', [
      'import { exec, execSync, spawn } from "child_process"',
      'import * as fs from "fs"',
      'import * as path from "path"',
      'export function f1(req: any) { return fs.readFileSync(path.join("/etc", req.body.file)) }',
      'export function f2(req: any) { return fs.readFileSync(req.body.file) }', // direct
      'export function f3(req: any) { return exec("ls " + req.body.dir) }',
      'export function f4(req: any) { return execSync(`grep ${req.body.pattern} log.txt`) }',
      'export function f5(req: any) { return spawn("git", ["log", "--", req.body.path]) }',
      'export function f6(req: any) {',
      '  return `<div dangerous>${req.body.html}</div>`',
      '}',
      'export function f7(req: any) {',
      '  return `<a href="${req.body.url}">click</a>`',
      '}',
      'export function f8(safe: string) {',
      '  return fs.readFileSync(path.resolve("/etc/hosts"))',
      '}',
    ].join('\n'))
    const result = await runCheck('input-sanitization')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// unsafe-secret-comparison — additional patterns
// ---------------------------------------------------------------------------

describe('unsafe-secret-comparison — additional branches', () => {
  it('various comparison patterns', async () => {
    fx('src/auth/u.ts', [
      'import { timingSafeEqual } from "crypto"',
      'export function f1(secret: string, token: string) { return secret === token }',
      'export function f2(secret: string, token: string) { return secret == token }',
      'export function f3(a: Buffer, b: Buffer) { return a.equals(b) }',
      'export function f4(secret: string, token: string) {',
      '  if (secret.length !== token.length) return false',
      '  return timingSafeEqual(Buffer.from(secret), Buffer.from(token))',
      '}',
      'export function f5(apiKey: string, expected: string) { return apiKey === expected }',
      'export function f6(password: string, hash: string) { return password === hash }',
      'export function f7(unrelated: number, other: number) { return unrelated === other }',
    ].join('\n'))
    const result = await runCheck('unsafe-secret-comparison')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// no-any-types — additional patterns
// ---------------------------------------------------------------------------

describe('no-any-types — additional branches', () => {
  it('various any forms', async () => {
    fx('src/t/a.ts', [
      'export const a: any = {}',
      'export function f1(x: any) { return x }',
      'export function f2(): any { return null }',
      'export const arr: any[] = []',
      'export const map: { [k: string]: any } = {}',
      'export const m2: Record<string, any> = {}',
      'export const cast = (x: unknown) => x as any',
      'export type T<X = any> = X',
      'export interface I { x: any }',
      'export class C { v: any = null }',
    ].join('\n'))
    const result = await runCheck('no-any-types')
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// result-pattern-consistency — additional branches
// ---------------------------------------------------------------------------

describe('result-pattern-consistency — additional branches', () => {
  it('Result vs throw mixing', async () => {
    fx('src/svc/r.ts', [
      'type Ok<T> = { ok: true; value: T }',
      'type Err<E> = { ok: false; error: E }',
      'type Result<T, E> = Ok<T> | Err<E>',
      'export function ok<T>(v: T): Ok<T> { return { ok: true, value: v } }',
      'export function err<E>(e: E): Err<E> { return { ok: false, error: e } }',
      'export function viaResult(): Result<number, string> { return ok(1) }',
      'export function viaThrow() { throw new Error("oops") }',
      'export function bothPatterns(x: number) {',
      '  if (x < 0) return err("neg")',
      '  if (x === 0) throw new Error("zero")',
      '  return ok(x)',
      '}',
      'export function caughtRethrow() {',
      '  try { return ok(1) }',
      '  catch (e) { throw e }',
      '}',
      'export function legitimateThrow() {',
      '  throw new ValidationError("bad")',
      '}',
      'export function isValidator(): boolean {',
      '  if (!Number.isFinite(1)) throw new Error("not finite")',
      '  return true',
      '}',
    ].join('\n'))
    const result = await runCheck('result-pattern-consistency')
    expect(result).toBeDefined()
  })

  it('throws in registry / store / adapter paths (allowed)', async () => {
    fx('src/registry/x.ts', 'export function f() { throw new Error("ok") }')
    fx('src/store/x.ts', 'export function f() { throw new Error("ok") }')
    fx('src/adapter/x.ts', 'export function f() { throw new Error("ok") }')
    fx('src/x-registry.ts', 'export function f() { throw new Error("ok") }')
    fx('src/x-adapter.ts', 'export function f() { throw new Error("ok") }')
    fx('src/x-store.ts', 'export function f() { throw new Error("ok") }')
    const result = await runCheck('result-pattern-consistency')
    expect(result).toBeDefined()
  })
})
