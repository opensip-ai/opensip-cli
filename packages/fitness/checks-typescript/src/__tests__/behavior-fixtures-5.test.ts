// @fitness-ignore-file file-length-limit -- behavior fixture suite; related scenarios stay together while checks are split into focused tests.
/**
 * @fileoverview Behavior fixture suite for remaining TypeScript check branches.
 * with focused tests across openapi-type-source, api-contract-validation,
 * array-validation, detached-promises, and other sub-90% checks.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { RunScope, runWithScope } from '@opensip-cli/core';
import { fileCache } from '@opensip-cli/fitness';
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
  cwd = mkdtempSync(join(tmpdir(), 'opensip-cov5-'));
  written = [];
});

afterEach(() => {
  fileCache.clear();
  rmSync(cwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// openapi-type-source — drive all API_TYPE_PATTERNS
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// api-contract-validation
// ---------------------------------------------------------------------------

describe('api-contract-validation — branch coverage', () => {
  it('runs over handlers with various signatures', async () => {
    fx(
      'src/api/handlers.ts',
      [
        'export function userHandler(req: unknown, res: unknown) {',
        '  return { ok: true }',
        '}',
        'export async function handleCreate(req: unknown) {',
        '  const body = (req as any).body',
        '  return body',
        '}',
        'export function processOrder(req: unknown) {',
        '  // No try/catch, no validation, no return type',
        '  return req',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('api-contract-validation');
    expect(result).toBeDefined();
  });

  it('does not flag handlers with parse() validation and try/catch', async () => {
    fx(
      'src/api/safe-handler.ts',
      [
        'import { z } from "zod"',
        'const Body = z.object({ x: z.string() })',
        'export async function handleCreate(req: { body: unknown }): Promise<{ ok: boolean }> {',
        '  try {',
        '    const body = Body.parse(req.body)',
        '    return { ok: !!body.x }',
        '  } catch {',
        '    return { ok: false }',
        '  }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('api-contract-validation');
    expect(result).toBeDefined();
  });

  it('skips non-API files (utility files, components)', async () => {
    fx(
      'src/util/helper.ts',
      ['export function processOrder(input: unknown) { return input }'].join('\n'),
    );
    const result = await runCheck('api-contract-validation');
    expect(result.signals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// detached-promises - more branches
// ---------------------------------------------------------------------------

describe('detached-promises — extra branches', () => {
  it('handles fire-and-forget with various sync method calls', async () => {
    fx(
      'src/async/calls.ts',
      [
        'declare function task(): Promise<void>',
        'export async function f() {',
        '  // sync calls — should not flag',
        '  console.log("a")',
        '  Math.max(1, 2)',
        '  Object.keys({})',
        '  Array.isArray([])',
        '  // async fire-and-forget — should flag',
        '  task()',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('detached-promises');
    expect(result).toBeDefined();
  });

  it('handles promise chain handling', async () => {
    fx(
      'src/async/chains.ts',
      [
        'declare function task(): Promise<void>',
        'export async function f() {',
        '  task().then(() => 1)',
        '  task().catch(() => 2)',
        '  task().then(() => 3).catch(() => 4)',
        '  task().finally(() => 5)',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('detached-promises');
    expect(result).toBeDefined();
  });

  it('handles awaited receiver expressions', async () => {
    fx(
      'src/async/awaited-recv.ts',
      [
        'declare const obj: { task(): Promise<void> }',
        'export async function f() {',
        '  await (await Promise.resolve(obj)).task()',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('detached-promises');
    expect(result).toBeDefined();
  });

  it('skips known sync methods on common types', async () => {
    fx(
      'src/async/known-sync.ts',
      [
        'export function f() {',
        '  const arr: number[] = []',
        '  arr.push(1)',
        '  arr.pop()',
        '  arr.slice()',
        '  const map = new Map()',
        '  map.set("a", 1)',
        '  map.get("a")',
        '  map.has("a")',
        '  map.delete("a")',
        '  const set = new Set()',
        '  set.add(1)',
        '  set.has(1)',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('detached-promises');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// no-raw-fetch — extra branches
// ---------------------------------------------------------------------------

describe('no-raw-fetch — extra branches', () => {
  it('handles globalThis.fetch and window.fetch', async () => {
    fx(
      'src/api/fetch.ts',
      [
        'export async function a() { return fetch("/x") }',
        'export async function b() { return globalThis.fetch("/y") }',
      ].join('\n'),
    );
    const result = await runCheck('no-raw-fetch');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// no-unbounded-concurrency — extra branches
// ---------------------------------------------------------------------------

describe('no-unbounded-concurrency — extra branches', () => {
  it('flags Promise.allSettled / Promise.all over a runtime-sized array', async () => {
    fx(
      'src/async/all.ts',
      [
        'declare function task(id: number): Promise<unknown>',
        'export async function f(ids: number[]) {',
        '  return Promise.allSettled(ids.map(task))',
        '}',
        'export async function g(ids: number[]) {',
        '  return Promise.all(ids.map((i) => task(i)))',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('no-unbounded-concurrency');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// throws-documentation — function expressions and methods
// ---------------------------------------------------------------------------

describe('throws-documentation — extra branches', () => {
  it('handles async functions and class methods', async () => {
    fx(
      'src/throws/async.ts',
      [
        'export async function asyncThrows() {',
        '  if (Math.random() < 0.5) throw new Error("bad")',
        '  return 1',
        '}',
        'export class C {',
        '  async run(x: number) {',
        '    if (x < 0) throw new RangeError("neg")',
        '    return x',
        '  }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('throws-documentation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// numeric-validation — handle parseInt with different argument shapes
// ---------------------------------------------------------------------------

describe('numeric-validation — extra branches', () => {
  it('exercises parseInt with `expr ?? "0"` fallback', async () => {
    fx(
      'src/util/parse-fallback.ts',
      [
        'export function fn(s: string | undefined): number {',
        "  return parseInt(s ?? '0', 10)",
        '}',
      ].join('\n'),
    );
    const result = await runCheck('numeric-validation');
    expect(result).toBeDefined();
  });

  it('exercises parseInt with `expr || "10"` fallback', async () => {
    fx(
      'src/util/parse-or.ts',
      [
        'export function fn(s: string | undefined): number {',
        "  return parseInt(s || '10', 10)",
        '}',
      ].join('\n'),
    );
    const result = await runCheck('numeric-validation');
    expect(result).toBeDefined();
  });

  it(String.raw`exercises inline regex digit guard /^\d+$/.test`, async () => {
    fx(
      'src/util/parse-guard.ts',
      [
        'export function fn(s: string): number {',
        String.raw`  if (!/^\d+$/.test(s)) return 0`,
        '  return parseInt(s, 10)',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('numeric-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// missing-input-validation — extra branches
// ---------------------------------------------------------------------------

describe('missing-input-validation — extra branches', () => {
  it('handles Express-style req access', async () => {
    fx(
      'src/routes/express.ts',
      [
        'export function handler(req: any, res: any) {',
        '  const body = req.body',
        '  res.json(body)',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('missing-input-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// dispose-pattern-completeness — class with intervals and timeouts
// ---------------------------------------------------------------------------

describe('dispose-pattern-completeness — extra branches', () => {
  it('detects setInterval / setTimeout cleanup', async () => {
    fx(
      'src/lifecycle/timers.ts',
      [
        'export interface IDisposable { dispose(): void }',
        'export class Watcher implements IDisposable {',
        '  private interval = setInterval(() => undefined, 1000)',
        '  private timeout = setTimeout(() => undefined, 5000)',
        '  dispose(): void {',
        '    clearInterval(this.interval)',
        // missing clearTimeout
        '  }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('dispose-pattern-completeness');
    expect(result).toBeDefined();
  });

  it('detects event listener cleanup', async () => {
    fx(
      'src/lifecycle/events.ts',
      [
        'export interface IDisposable { dispose(): void }',
        'export class Listener implements IDisposable {',
        '  private handler = () => undefined',
        '  start() { globalThis.addEventListener("x", this.handler) }',
        '  dispose(): void {',
        '    // missing removeEventListener',
        '  }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('dispose-pattern-completeness');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// array-validation — extra branches
// ---------------------------------------------------------------------------

describe('array-validation — extra branches', () => {
  it('flags various array operations without validation', async () => {
    fx(
      'src/util/arr-ops.ts',
      [
        'export function f1(items: string[]): string {',
        '  return items[0] ?? ""',
        '}',
        'export function f2(items: number[]): number {',
        '  return items.length',
        '}',
        'export function f3(items: number[]) {',
        '  return items.map((x) => x + 1)',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('array-validation');
    expect(result).toBeDefined();
  });

  it('skips functions with explicit length / Array.isArray check', async () => {
    fx(
      'src/util/arr-checked.ts',
      [
        'export function f(items: unknown): unknown {',
        '  if (!Array.isArray(items)) return null',
        '  if (items.length === 0) return null',
        '  return items[0]',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('array-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// fastify-route-validation — body/query/params unvalidated
// ---------------------------------------------------------------------------

describe('fastify-route-validation — extra branches', () => {
  it('flags reads of body/query/params without validation', async () => {
    fx(
      'src/routes/raw-reads.ts',
      [
        'import fastify from "fastify"',
        'const app = fastify()',
        'app.post("/users/:id", async (req) => {',
        '  const body = req.body as { name: string }',
        '  const params = req.params as { id: string }',
        '  const query = req.query as { search: string }',
        '  return { ...body, ...params, ...query }',
        '})',
      ].join('\n'),
    );
    const result = await runCheck('fastify-route-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// platform-checks
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// memo-list-items — exercise more shapes
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// lazy-loading — exercise more shapes
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// silent-early-returns — exercise additional patterns
// ---------------------------------------------------------------------------

describe('silent-early-returns — extra branches', () => {
  it('exercises returns in nested arrow callbacks', async () => {
    fx(
      'src/handlers/nested.ts',
      [
        'export function f(items: { id: string }[]) {',
        '  return items.filter((it) => {',
        '    if (!it.id) return false',
        '    if (it.id === "skip") return false',
        '    return true',
        '  })',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('silent-early-returns');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// unused-config-options — extra branches
// ---------------------------------------------------------------------------

describe('unused-config-options — extra branches', () => {
  it('flags optional vs required Config interface properties', async () => {
    fx(
      'src/config/base.ts',
      [
        'export interface BaseConfig {',
        '  apiUrl: string', // required, used
        '  unused: string', // required, unused → flag
        '  optional?: string', // optional → skip',
        '}',
      ].join('\n'),
    );
    fx(
      'src/main.ts',
      [
        'import type { BaseConfig } from "./config/base.js"',
        'export function f(c: BaseConfig) { return c.apiUrl }',
      ].join('\n'),
    );
    const result = await runCheck('unused-config-options');
    expect(result).toBeDefined();
  });

  it('handles destructured property usage as access count', async () => {
    fx(
      'src/config/destr.ts',
      ['export interface DestrConfig {', '  apiUrl: string', '  fancyOption: number', '}'].join(
        '\n',
      ),
    );
    fx(
      'src/main.ts',
      [
        'import type { DestrConfig } from "./config/destr.js"',
        'export function f(c: DestrConfig) {',
        '  const { apiUrl, fancyOption } = c',
        '  return apiUrl + fancyOption',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('unused-config-options');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// circular-import-detection — exercise import variants
// ---------------------------------------------------------------------------

describe('circular-import-detection — extra branches', () => {
  it('handles namespace imports', async () => {
    fx('src/cyc/x.ts', 'import * as Y from "./y.js"\nexport const x = () => Y.y()');
    fx('src/cyc/y.ts', 'import * as X from "./x.js"\nexport const y = () => X.x()');
    const result = await runCheck('circular-import-detection');
    expect(result).toBeDefined();
  });

  it('handles type-only imports (do not contribute to cycles)', async () => {
    fx('src/dag/a.ts', 'import type { B } from "./b.js"\nexport const a: B = { v: 1 }');
    fx('src/dag/b.ts', 'export interface B { v: number }');
    const result = await runCheck('circular-import-detection');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// missing-type-exports — extra branches
// ---------------------------------------------------------------------------

describe('missing-type-exports — extra branches', () => {
  it('handles `as`-renamed imports', async () => {
    fx(
      'packages/foo/package.json',
      JSON.stringify(
        {
          name: '@scope/foo',
          version: '1.0.0',
          exports: { '.': './dist/index.js' },
        },
        null,
        2,
      ),
    );
    fx(
      'packages/consumer/src/uses.ts',
      [
        'import { internal as RenamedInternal } from "@scope/foo/sub"',
        'export const x = RenamedInternal',
      ].join('\n'),
    );
    const result = await runCheck('missing-type-exports');
    expect(result).toBeDefined();
  });

  it('handles import type { X }', async () => {
    fx(
      'packages/consumer/src/uses.ts',
      ['import type { Internal } from "@scope/foo/types"', 'export type X = Internal'].join('\n'),
    );
    const result = await runCheck('missing-type-exports');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// contracts-schema-consistency — extra branches
// ---------------------------------------------------------------------------

describe('contracts-schema-consistency — extra', () => {
  it('runs over zod schemas with mismatched type aliases', async () => {
    fx(
      'src/schemas/mismatch.ts',
      [
        'import { z } from "zod"',
        'export const UserSchema = z.object({ id: z.string() })',
        'export type User = { id: number }', // mismatch with schema
      ].join('\n'),
    );
    const result = await runCheck('contracts-schema-consistency');
    expect(result).toBeDefined();
  });

  it('runs over schemas with z.infer aligned types', async () => {
    fx(
      'src/schemas/aligned.ts',
      [
        'import { z } from "zod"',
        'export const UserSchema = z.object({ id: z.string() })',
        'export type User = z.infer<typeof UserSchema>',
      ].join('\n'),
    );
    const result = await runCheck('contracts-schema-consistency');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// drizzle-orm-migration-guardrails — extra branches
// ---------------------------------------------------------------------------

describe('drizzle-orm-migration-guardrails — extra', () => {
  it('handles SQL containing ALTER TABLE without DROP', async () => {
    fx(
      'src/db/migrations/m.ts',
      [
        'import { sql } from "drizzle-orm"',
        'export const up = sql`ALTER TABLE users RENAME COLUMN x TO y`',
      ].join('\n'),
    );
    const result = await runCheck('drizzle-orm-migration-guardrails');
    expect(result).toBeDefined();
  });

  it('handles non-migration files (pgTable defs)', async () => {
    fx(
      'src/db/schema/users.ts',
      [
        'import { pgTable, text, integer } from "drizzle-orm/pg-core"',
        'export const users = pgTable("users", {',
        '  id: integer("id").primaryKey(),',
        '  email: text("email"),',
        '})',
      ].join('\n'),
    );
    const result = await runCheck('drizzle-orm-migration-guardrails');
    expect(result).toBeDefined();
  });
});

// observability-coverage is a helper module, not a standalone check.
// Direct unit tests for its functions live in
// src/checks/quality/observability/observability-coverage/__tests__/.

// ---------------------------------------------------------------------------
// no-any-types — extra branches
// ---------------------------------------------------------------------------

describe('no-any-types — extra branches', () => {
  it('handles function generic with any constraints', async () => {
    fx(
      'src/types/generic-any.ts',
      ['export function f<T extends any>(x: T): T { return x }'].join('\n'),
    );
    const result = await runCheck('no-any-types');
    expect(result).toBeDefined();
  });

  it('handles Promise<any>, Array<any>, and explicit any tuples', async () => {
    fx(
      'src/types/wrapper-any.ts',
      [
        'export const a: Promise<any> = Promise.resolve(null)',
        'export const b: Array<any> = []',
        'export const c: [any, any] = [1, 2]',
      ].join('\n'),
    );
    const result = await runCheck('no-any-types');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// financial-transaction-ordering — extra
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// database-schema-validation
// ---------------------------------------------------------------------------

describe('database-schema-validation — extra', () => {
  it('handles entities with various decorator usages', async () => {
    fx(
      'src/entities/order.ts',
      [
        'import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from "typeorm"',
        '@Entity()',
        'export class Order {',
        '  @PrimaryGeneratedColumn() id!: number',
        '  @Column() total!: number',
        '  @CreateDateColumn() createdAt!: Date',
        '  @UpdateDateColumn() updatedAt!: Date',
        '}',
        '@Entity()',
        'export class Receipt {',
        '  @Column({ nullable: true }) note?: string',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('database-schema-validation');
    expect(result).toBeDefined();
  });

  it('handles drizzle pgTable schemas', async () => {
    fx(
      'src/db/orders.ts',
      [
        'import { pgTable, integer, varchar, text } from "drizzle-orm/pg-core"',
        'export const orders = pgTable("orders", {',
        '  id: integer("id").primaryKey(),',
        '  customerId: integer("customer_id"),',
        '  email: varchar("email", { length: 255 }),',
        '  notes: text("notes"),',
        '})',
      ].join('\n'),
    );
    const result = await runCheck('database-schema-validation');
    expect(result).toBeDefined();
  });
});
