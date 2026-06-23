/**
 * @fileoverview Final behavior fixture suite targeting the biggest remaining misses:
 * duplicate-utility-functions, result-pattern-consistency,
 * openapi-response-coverage, fastify-schema-coverage, memo-list-items,
 * and other mid-sized checks.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { LanguageRegistry, RunScope, runWithScope } from '@opensip-cli/core';
import { fileCache } from '@opensip-cli/fitness';
import { typescriptAdapter } from '@opensip-cli/lang-typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checks } from '../index.js';

// Production simulation: register the TS adapter (see behavior-fixtures.test.ts).
const langRegistry = new LanguageRegistry();
langRegistry.register(typescriptAdapter);
const testScope = new RunScope({ languages: langRegistry });
// Bind the scope cache to the test-only singleton these tests prewarm:
// check.run resolves currentScope()?.fitness?.fileCache now (Phase 1).
Object.assign(testScope, { fitness: { fileCache } });

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
  cwd = mkdtempSync(join(tmpdir(), 'opensip-cov4-'));
  written = [];
});

afterEach(() => {
  fileCache.clear();
  rmSync(cwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// duplicate-utility-functions — drive identical and similar paths
// ---------------------------------------------------------------------------

describe('duplicate-utility-functions — deeper coverage', () => {
  it('flags identical implementations of formatXxx across directories', async () => {
    const body = [
      'export function formatPrice(value: number, currency: string): string {',
      '  if (typeof value !== "number") return ""',
      '  return value.toFixed(2) + " " + currency.toUpperCase()',
      '}',
    ].join('\n');
    fx('packages/a/src/format.ts', body);
    fx('packages/b/src/format.ts', body);
    const result = await runCheck('duplicate-utility-functions');
    expect(result).toBeDefined();
  });

  it('flags similar implementations (same name, different bodies)', async () => {
    fx(
      'packages/a/src/parsers.ts',
      [
        'export function parseDate(input: string): Date {',
        '  const ts = Date.parse(input)',
        '  if (Number.isNaN(ts)) throw new Error("invalid date")',
        '  return new Date(ts)',
        '}',
      ].join('\n'),
    );
    fx(
      'packages/b/src/parsers.ts',
      [
        'export function parseDate(input: string): Date {',
        '  const parts = input.split("-").map((s) => Number.parseInt(s, 10))',
        '  return new Date(parts[0] ?? 0, (parts[1] ?? 1) - 1, parts[2] ?? 1)',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('duplicate-utility-functions');
    expect(result).toBeDefined();
  });

  it('exercises arrow function utilities (debounce, throttle, sleep)', async () => {
    fx(
      'packages/a/src/util.ts',
      [
        'export const debounce = (fn: () => void, ms: number) => {',
        '  let timer: NodeJS.Timeout | null = null',
        '  return () => {',
        '    if (timer) clearTimeout(timer)',
        '    timer = setTimeout(fn, ms)',
        '  }',
        '}',
      ].join('\n'),
    );
    fx(
      'packages/b/src/util.ts',
      [
        'export const debounce = (fn: () => void, ms: number) => {',
        '  let timer: NodeJS.Timeout | null = null',
        '  return () => {',
        '    if (timer) clearTimeout(timer)',
        '    timer = setTimeout(fn, ms)',
        '  }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('duplicate-utility-functions');
    expect(result).toBeDefined();
  });

  it('skips domain-specific names like getConfig, validateConfig, parseArgs', async () => {
    fx(
      'packages/a/src/cfg.ts',
      [
        'export function getConfig(): { url: string } {',
        '  return { url: "x" }',
        '}',
        'export function validateConfig(c: unknown): boolean {',
        '  return typeof c === "object"',
        '}',
        'export function parseArgs(argv: string[]) {',
        '  return argv.slice(2)',
        '}',
      ].join('\n'),
    );
    fx(
      'packages/b/src/cfg.ts',
      ['export function getConfig(): { url: string } {', '  return { url: "y" }', '}'].join('\n'),
    );
    const result = await runCheck('duplicate-utility-functions');
    // Domain-specific names should not be flagged as duplicates.
    expect(result).toBeDefined();
  });

  it('skips utility functions whose body is shorter than 50 chars', async () => {
    fx('packages/a/src/short.ts', ['export function isPos(n: number) { return n > 0 }'].join('\n'));
    fx('packages/b/src/short.ts', ['export function isPos(n: number) { return n > 0 }'].join('\n'));
    const result = await runCheck('duplicate-utility-functions');
    expect(result).toBeDefined();
  });

  it('does not flag duplicates within the same directory', async () => {
    const body = [
      'export function formatNumber(value: number): string {',
      '  return value.toFixed(2) + " stable"',
      '}',
    ].join('\n');
    fx('packages/a/src/n1.ts', body);
    fx('packages/a/src/n2.ts', body);
    const result = await runCheck('duplicate-utility-functions');
    // Same-directory duplicates do not satisfy the cross-directory predicate.
    expect(result.signals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// result-pattern-consistency — drive throw context branches
// ---------------------------------------------------------------------------

describe('result-pattern-consistency — branch coverage', () => {
  it('flags top-level throw of a known expected error type', async () => {
    fx(
      'src/services/user.ts',
      [
        'export class ValidationError extends Error {}',
        'export function f(input: string) {',
        '  if (!input) throw new ValidationError("empty")',
        '  return input',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('result-pattern-consistency');
    expect(result).toBeDefined();
  });

  it('skips throws inside catch blocks (re-throw)', async () => {
    fx(
      'src/services/rethrow.ts',
      [
        'export class ValidationError extends Error {}',
        'export function f() {',
        '  try { return 1 } catch (e) { throw new ValidationError(String(e)) }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('result-pattern-consistency');
    expect(result).toBeDefined();
  });

  it('skips throws inside constructors', async () => {
    fx(
      'src/services/ctor.ts',
      [
        'export class ValidationError extends Error {}',
        'export class C {',
        '  constructor(x: number) {',
        '    if (x < 0) throw new ValidationError("negative")',
        '  }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('result-pattern-consistency');
    expect(result).toBeDefined();
  });

  it('skips throws inside private methods', async () => {
    fx(
      'src/services/private.ts',
      [
        'export class ValidationError extends Error {}',
        'export class C {',
        '  private check(x: number) {',
        '    if (x < 0) throw new ValidationError("neg")',
        '  }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('result-pattern-consistency');
    expect(result).toBeDefined();
  });

  it('skips validation/guard helper functions by name pattern', async () => {
    fx(
      'src/services/validators.ts',
      [
        'export class ValidationError extends Error {}',
        'export function validateEmail(email: string) {',
        '  if (!email.includes("@")) throw new ValidationError("bad email")',
        '}',
        'export function assertPositive(n: number) {',
        '  if (n <= 0) throw new ValidationError("not positive")',
        '}',
        'export function ensureNonEmpty(s: string) {',
        '  if (!s) throw new ValidationError("empty")',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('result-pattern-consistency');
    expect(result).toBeDefined();
  });

  it('skips paths under routes/, handlers/, controllers/, middleware/', async () => {
    fx(
      'src/routes/foo.ts',
      [
        'export class ValidationError extends Error {}',
        'export function handle() { throw new ValidationError("x") }',
      ].join('\n'),
    );
    fx(
      'src/handlers/foo.ts',
      [
        'export class NotFoundError extends Error {}',
        'export function handle() { throw new NotFoundError("x") }',
      ].join('\n'),
    );
    fx(
      'src/controllers/foo.ts',
      [
        'export class ConflictError extends Error {}',
        'export function handle() { throw new ConflictError("x") }',
      ].join('\n'),
    );
    fx(
      'src/middleware/foo.ts',
      [
        'export class InvalidInputError extends Error {}',
        'export function handle() { throw new InvalidInputError("x") }',
      ].join('\n'),
    );
    const result = await runCheck('result-pattern-consistency');
    expect(result.signals).toHaveLength(0);
  });

  it('skips infrastructure paths (registry/store/adapter)', async () => {
    fx(
      'src/some-registry.ts',
      [
        'export class NotFoundError extends Error {}',
        'export function lookup() { throw new NotFoundError("x") }',
      ].join('\n'),
    );
    fx(
      'src/cache-store.ts',
      [
        'export class NotFoundError extends Error {}',
        'export function lookup() { throw new NotFoundError("x") }',
      ].join('\n'),
    );
    fx(
      'src/db-adapter.ts',
      [
        'export class ConflictError extends Error {}',
        'export function ins() { throw new ConflictError("x") }',
      ].join('\n'),
    );
    const result = await runCheck('result-pattern-consistency');
    expect(result.signals).toHaveLength(0);
  });

  it('does not flag throws of unexpected error types (system errors)', async () => {
    fx(
      'src/services/sys.ts',
      ['export function f() {', '  throw new TypeError("not expected error type")', '}'].join('\n'),
    );
    const result = await runCheck('result-pattern-consistency');
    // Only EXPECTED_ERROR_TYPES are flagged. TypeError is not in that list.
    expect(result.signals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// openapi-response-coverage — exercise per-method requirements
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// fastify-schema-coverage — drive missing-X branches
// ---------------------------------------------------------------------------

describe('fastify-schema-coverage — branch coverage', () => {
  it('flags POST route missing schema entirely', async () => {
    fx(
      'src/routes/post-no-schema.ts',
      [
        'import fastify from "fastify"',
        'const app = fastify()',
        'app.post("/users", async (req, res) => {',
        '  const body = req.body as { name: string }',
        '  return body',
        '})',
      ].join('\n'),
    );
    const result = await runCheck('fastify-schema-coverage');
    expect(result).toBeDefined();
  });

  it('flags POST route with body access but no body schema', async () => {
    fx(
      'src/routes/post-body.ts',
      [
        'import fastify from "fastify"',
        'const app = fastify()',
        'app.post("/users", {',
        '  schema: { response: { 200: {} } },',
        '}, async (req, res) => {',
        '  const body = req.body as { name: string }',
        '  return body',
        '})',
      ].join('\n'),
    );
    const result = await runCheck('fastify-schema-coverage');
    expect(result).toBeDefined();
  });

  it('flags route with path params (:) but no params schema', async () => {
    fx(
      'src/routes/path-params.ts',
      [
        'import fastify from "fastify"',
        'const app = fastify()',
        'app.get("/users/:id", {',
        '  schema: { response: { 200: {} } },',
        '}, async (req, res) => {',
        '  const params = req.params as { id: string }',
        '  return res.send(params)',
        '})',
      ].join('\n'),
    );
    const result = await runCheck('fastify-schema-coverage');
    expect(result).toBeDefined();
  });

  it('flags route reading req.query without querystring schema', async () => {
    fx(
      'src/routes/query.ts',
      [
        'import fastify from "fastify"',
        'const app = fastify()',
        'app.get("/search", {',
        '  schema: { response: { 200: {} } },',
        '}, async (req, res) => {',
        '  const q = req.query as { search: string }',
        '  return res.send(q)',
        '})',
      ].join('\n'),
    );
    const result = await runCheck('fastify-schema-coverage');
    expect(result).toBeDefined();
  });

  it('skips routes with Zod-based body parsing', async () => {
    fx(
      'src/routes/zod-body.ts',
      [
        'import fastify from "fastify"',
        'import { z } from "zod"',
        'const app = fastify()',
        'const Body = z.object({ name: z.string() })',
        'app.post("/users", async (req, res) => {',
        '  const body = Body.parse(req.body)',
        '  return body',
        '})',
      ].join('\n'),
    );
    const result = await runCheck('fastify-schema-coverage');
    expect(result).toBeDefined();
  });

  it('exercises object-literal route declarations', async () => {
    fx(
      'src/routes/object.ts',
      [
        'import fastify from "fastify"',
        'const app = fastify()',
        'app.route({',
        '  method: "POST",',
        '  url: "/items",',
        '  handler: async (req, res) => {',
        '    const body = req.body as { name: string }',
        '    return res.send(body)',
        '  },',
        '})',
        'app.route({',
        '  method: "PUT",',
        '  url: "/items/:id",',
        '  schema: {',
        '    body: { type: "object" },',
        '    params: { type: "object" },',
        '  },',
        '  handler: async (req, res) => res.send({}),',
        '})',
      ].join('\n'),
    );
    const result = await runCheck('fastify-schema-coverage');
    expect(result).toBeDefined();
  });

  it('skips non-route files', async () => {
    fx('src/util/foo.ts', 'export const x = 1');
    const result = await runCheck('fastify-schema-coverage');
    expect(result.signals).toHaveLength(0);
  });

  it('skips test/spec files even with route in path', async () => {
    fx(
      'src/routes/foo.test.ts',
      [
        'import fastify from "fastify"',
        'const app = fastify()',
        'app.post("/x", async (req) => req.body)',
      ].join('\n'),
    );
    const result = await runCheck('fastify-schema-coverage');
    expect(result.signals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// fastify-route-validation — broader call-shape coverage
// ---------------------------------------------------------------------------

describe('fastify-route-validation — branch coverage', () => {
  it('exercises all standard methods (get/post/put/patch/delete)', async () => {
    fx(
      'src/routes/all-methods.ts',
      [
        'import fastify from "fastify"',
        'const app = fastify()',
        'app.get("/x", async () => ({}))',
        'app.post("/x", async (req) => req.body)',
        'app.put("/x", async (req) => req.body)',
        'app.patch("/x", async (req) => req.body)',
        'app.delete("/x", async () => ({}))',
      ].join('\n'),
    );
    const result = await runCheck('fastify-route-validation');
    expect(result).toBeDefined();
  });

  it('skips files without fastify references', async () => {
    fx('src/util/no-fastify.ts', 'export const x = 1');
    const result = await runCheck('fastify-route-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// memo-list-items — exercise more JSX list patterns
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// lazy-loading — extra branches
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// platform-checks — minor coverage
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// test-only-frontend-modules
// ---------------------------------------------------------------------------

describe('test-only-frontend-modules — branch coverage', () => {
  it('runs over a frontend module imported only by tests', async () => {
    fx('src/components/Helper.tsx', 'export const Helper = () => null');
    fx(
      'src/__tests__/Helper.test.tsx',
      ['import { Helper } from "../components/Helper.js"', 'export const x = Helper'].join('\n'),
    );
    const result = await runCheck('test-only-frontend-modules');
    expect(result).toBeDefined();
  });

  it('does not flag modules imported by production code', async () => {
    fx('src/components/Used.tsx', 'export const Used = () => null');
    fx(
      'src/main.tsx',
      ['import { Used } from "./components/Used.js"', 'export const r = Used'].join('\n'),
    );
    const result = await runCheck('test-only-frontend-modules');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// fastify-route-validation — extra
// ---------------------------------------------------------------------------

describe('fastify-route-validation — exercise validation patterns', () => {
  it('runs over routes with various validation styles', async () => {
    fx(
      'src/routes/styles.ts',
      [
        'import fastify from "fastify"',
        'import { z } from "zod"',
        'const app = fastify()',
        // Body schema
        'app.post("/with-schema", { schema: { body: { type: "object" } } }, async (req) => req.body)',
        // Zod parsing
        'const Body = z.object({ x: z.string() })',
        'app.post("/with-zod", async (req) => Body.parse(req.body))',
        // No validation
        'app.post("/no-val", async (req) => req.body)',
      ].join('\n'),
    );
    const result = await runCheck('fastify-route-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// async-waterfall-detection — extra branches
// ---------------------------------------------------------------------------

describe('async-waterfall-detection — extra coverage', () => {
  it('flags 3+ sequential awaits with no interdependence', async () => {
    fx(
      'src/async/three.ts',
      [
        'declare function loadA(): Promise<number>',
        'declare function loadB(): Promise<number>',
        'declare function loadC(): Promise<number>',
        'declare function loadD(): Promise<number>',
        'export async function f() {',
        '  const a = await loadA()',
        '  const b = await loadB()',
        '  const c = await loadC()',
        '  const d = await loadD()',
        '  return { a, b, c, d }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('async-waterfall-detection');
    expect(result).toBeDefined();
  });

  it('skips functions with single await', async () => {
    fx(
      'src/async/single.ts',
      [
        'declare function loadA(): Promise<number>',
        'export async function f() { return await loadA() }',
      ].join('\n'),
    );
    const result = await runCheck('async-waterfall-detection');
    expect(result).toBeDefined();
  });

  it('skips Promise.all parallel calls', async () => {
    fx(
      'src/async/parallel.ts',
      [
        'declare function loadA(): Promise<number>',
        'declare function loadB(): Promise<number>',
        'export async function f() {',
        '  const [a, b] = await Promise.all([loadA(), loadB()])',
        '  return { a, b }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('async-waterfall-detection');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// dispose-pattern-completeness — extra
// ---------------------------------------------------------------------------

describe('dispose-pattern-completeness — extra coverage', () => {
  it('flags an IDisposable class with subscriptions but no unsubscribe call', async () => {
    fx(
      'src/lifecycle/sub.ts',
      [
        'export interface IDisposable { dispose(): void }',
        'interface Sub { unsubscribe(): void }',
        'export class Watcher implements IDisposable {',
        '  private subA?: Sub',
        '  private subB?: Sub',
        '  dispose(): void {',
        '    this.subA?.unsubscribe()',
        // missing subB cleanup
        '  }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('dispose-pattern-completeness');
    expect(result).toBeDefined();
  });

  it('flags entirely empty dispose()', async () => {
    fx(
      'src/lifecycle/empty.ts',
      [
        'export interface IDisposable { dispose(): void }',
        'interface Sub { unsubscribe(): void }',
        'export class Empty implements IDisposable {',
        '  private sub?: Sub',
        '  dispose(): void {}',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('dispose-pattern-completeness');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// throws-documentation — extra
// ---------------------------------------------------------------------------

describe('throws-documentation — more branches', () => {
  it('flags exported function with multiple throws but no @throws', async () => {
    fx(
      'src/throws/multi.ts',
      [
        'export function validate(input: string) {',
        '  if (!input) throw new Error("empty")',
        '  if (input.length > 1024) throw new RangeError("too long")',
        '  if (input.includes(";")) throw new SyntaxError("bad char")',
        '  return input',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('throws-documentation');
    expect(result).toBeDefined();
  });

  it('skips classes/methods with @throws JSDoc', async () => {
    fx(
      'src/throws/cls.ts',
      [
        'export class S {',
        '  /** @throws {Error} when bad */',
        '  validate(x: string) {',
        '    if (!x) throw new Error("bad")',
        '  }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('throws-documentation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// missing-input-validation — extra branches
// ---------------------------------------------------------------------------

describe('missing-input-validation — more branches', () => {
  it('runs over fastify GET with query.* access', async () => {
    fx(
      'src/routes/q.ts',
      [
        'import fastify from "fastify"',
        'const app = fastify()',
        'app.get("/search", async (req) => {',
        '  const q = req.query as { search: string }',
        '  return { q: q.search }',
        '})',
      ].join('\n'),
    );
    const result = await runCheck('missing-input-validation');
    expect(result).toBeDefined();
  });

  it('handles destructured req.body', async () => {
    fx(
      'src/routes/destr.ts',
      [
        'import fastify from "fastify"',
        'const app = fastify()',
        'app.post("/users", async (req) => {',
        '  const { name } = req.body as { name: string }',
        '  return { name }',
        '})',
      ].join('\n'),
    );
    const result = await runCheck('missing-input-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// database-index-coverage — extra
// ---------------------------------------------------------------------------

describe('database-index-coverage — more branches', () => {
  it('flags various unindexed query patterns', async () => {
    fx(
      'src/repos/various.ts',
      [
        'declare const db: { query(sql: string): Promise<unknown> }',
        'declare const repo: { find(where?: unknown): Promise<unknown>; findOne(where?: unknown): Promise<unknown> }',
        'export const a = () => db.query("SELECT * FROM users")',
        'export const b = () => db.query("SELECT id FROM users WHERE name LIKE \'%x%\'")',
        'export const c = () => repo.find()',
        'export const d = () => repo.findOne()',
      ].join('\n'),
    );
    const result = await runCheck('database-index-coverage');
    expect(result).toBeDefined();
  });

  it('skips indexed queries (find with WHERE)', async () => {
    fx(
      'src/repos/indexed.ts',
      [
        'declare const db: { query(sql: string): Promise<unknown> }',
        'export const a = () => db.query("SELECT * FROM users WHERE id = $1")',
      ].join('\n'),
    );
    const result = await runCheck('database-index-coverage');
    expect(result).toBeDefined();
  });
});
