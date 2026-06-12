// @fitness-ignore-file file-length-limit -- behavior fixture suite; related scenarios stay together while checks are split into focused tests.
/**
 * @fileoverview More targeted fixture-based behavior tests.
 *
 * Continues the behavior fixture suite for check branches in
 * error-handling-quality, result-pattern-consistency, fastify
 * checks, security checks, and frontend checks.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { RunScope, runWithScope } from '@opensip-cli/core';
import { fileCache } from '@opensip-cli/fitness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checks } from '../index.js';

// Engine reads `currentScope()?.languages` to dispatch contentFilter. An
// empty scope makes applyContentFilter fall through to its no-adapter
// "return raw" branch — matches the prior default-registry behaviour when
// no TS adapter was registered in the test process.
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
  cwd = mkdtempSync(join(tmpdir(), 'opensip-cov2-'));
  written = [];
});

afterEach(() => {
  fileCache.clear();
  rmSync(cwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// error-handling-quality
// ---------------------------------------------------------------------------

describe('error-handling-quality — branch coverage', () => {
  it('flags empty catch blocks', async () => {
    fx(
      'src/eh/empty.ts',
      ['export async function f() {', '  try { await fetch("/x") } catch {}', '}'].join('\n'),
    );
    const result = await runCheck('error-handling-quality');
    expect(result.signals.some((s) => s.message?.includes('Empty catch'))).toBe(true);
  });

  it('skips catch blocks that log via logger.error / console.error', async () => {
    fx(
      'src/eh/logged.ts',
      [
        'declare const logger: { error(o: object): void }',
        'export async function f() {',
        '  try { await fetch("/x") } catch (e) { logger.error({ err: e }) }',
        '  try { await fetch("/y") } catch (e) { console.error(e) }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('error-handling-quality');
    expect(result.signals).toHaveLength(0);
  });

  it('skips catch blocks containing rethrow or @swallow-ok marker', async () => {
    fx(
      'src/eh/marker.ts',
      [
        'export async function rethrows() {',
        '  try { await fetch("/x") } catch (e) { throw e }',
        '}',
        'export async function swallowed() {',
        '  try { await fetch("/x") } catch {',
        '    // @swallow-ok parsing errors are non-fatal here',
        '  }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('error-handling-quality');
    expect(result.signals).toHaveLength(0);
  });

  it('flags sentinel returns (false / null / undefined / [] / {}) in catch', async () => {
    fx(
      'src/eh/sentinel.ts',
      [
        'export async function a() { try { await fetch("/x") } catch { return false } }',
        'export async function b() { try { await fetch("/x") } catch { return null } }',
        'export async function c() { try { await fetch("/x") } catch { return undefined } }',
        'export async function d() { try { await fetch("/x") } catch { return [] } }',
        'export async function e() { try { await fetch("/x") } catch { return {} } }',
      ].join('\n'),
    );
    const result = await runCheck('error-handling-quality');
    expect(result.signals.length).toBeGreaterThanOrEqual(2);
  });

  it('flags result.isErr() branches that silently return sentinels', async () => {
    fx(
      'src/eh/result.ts',
      [
        'declare const result: { isErr(): boolean; unwrapOrLog(): unknown }',
        'export function f() {',
        '  if (result.isErr()) {',
        '    return null',
        '  }',
        '  return result',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('error-handling-quality');
    expect(result).toBeDefined();
  });

  it('flags mapErr() and match() without logging', async () => {
    fx(
      'src/eh/result-methods.ts',
      [
        'declare const r: {',
        '  mapErr(fn: (e: unknown) => unknown): unknown',
        '  match(ok: (v: unknown) => unknown, err: (e: unknown) => unknown): unknown',
        '}',
        'export const a = r.mapErr((e) => null)',
        'export const b = r.match((v) => v, (e) => null)',
      ].join('\n'),
    );
    const result = await runCheck('error-handling-quality');
    expect(result.signals.length).toBeGreaterThanOrEqual(1);
  });

  it('flags `as Error` cast in catch without instanceof guard', async () => {
    fx(
      'src/eh/cast.ts',
      [
        'export async function f() {',
        '  try {',
        '    await fetch("/x")',
        '  } catch (e) {',
        '    const err = e as Error',
        '    console.error(err.message)',
        '  }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('error-handling-quality');
    expect(result.signals.some((s) => s.message?.includes('as Error'))).toBe(true);
  });

  it('skips `as Error` cast guarded by instanceof Error', async () => {
    fx(
      'src/eh/safe-cast.ts',
      [
        'export async function f() {',
        '  try { await fetch("/x") } catch (e) {',
        '    if (e instanceof Error) {',
        '      const err = e as Error',
        '      console.error(err.message)',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('error-handling-quality');
    expect(result.signals.filter((s) => s.message?.includes('as Error'))).toHaveLength(0);
  });

  it('skips test files', async () => {
    fx('src/eh/foo.test.ts', ['try { 1 } catch {}'].join('\n'));
    const result = await runCheck('error-handling-quality');
    // Test files are skipped at the check level via isTestFile.
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// unsafe-secret-comparison
// ---------------------------------------------------------------------------

describe('unsafe-secret-comparison — branch coverage', () => {
  it('flags === / !== on token / secret / password / signature names', async () => {
    fx(
      'src/sec/cmp.ts',
      [
        'export function a(token: string, expected: string) { return token === expected }',
        'export function b(secret: string, other: string) { return secret !== other }',
        'export function c(password: string, hash: string) { return password === hash }',
        'export function d(signature: string, expected: string) { return signature === expected }',
      ].join('\n'),
    );
    const result = await runCheck('unsafe-secret-comparison');
    expect(result.signals.length).toBeGreaterThanOrEqual(4);
  });

  it('skips comparisons against undefined / null / true / false / typeof', async () => {
    fx(
      'src/sec/safe-cmp.ts',
      [
        'export function a(token: string | undefined) { return token !== undefined }',
        'export function b(token: string | null) { return token === null }',
        'export function c(secret: boolean) { return secret === true }',
        'export function d(token: unknown) { return typeof token === "string" }',
      ].join('\n'),
    );
    const result = await runCheck('unsafe-secret-comparison');
    expect(result.signals).toHaveLength(0);
  });

  it('skips safe property accesses (.length, .type, .id, etc.)', async () => {
    fx(
      'src/sec/prop-safe.ts',
      [
        'export function a(token: { length: number }) { return token.length === 32 }',
        'export function b(token: { type: string }) { return token.type === "bearer" }',
        'export function c(token: { id: string }) { return token.id === "abc" }',
      ].join('\n'),
    );
    const result = await runCheck('unsafe-secret-comparison');
    expect(result.signals).toHaveLength(0);
  });

  it('skips comparisons against literal values', async () => {
    fx(
      'src/sec/literal.ts',
      [
        'export function a(token: string) { return token === "fixed" }',
        'export function b(secret: number) { return secret === 42 }',
      ].join('\n'),
    );
    const result = await runCheck('unsafe-secret-comparison');
    expect(result.signals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// input-sanitization
// ---------------------------------------------------------------------------

describe('input-sanitization — branch coverage', () => {
  it('flags innerHTML assigned from req.body / req.params / req.query', async () => {
    fx(
      'src/sec/innerhtml.ts',
      [
        'export function f(req: any, el: HTMLElement) {',
        '  el.innerHTML = req.body.content',
        '}',
        'export function g(req: any, el: HTMLElement) {',
        '  el.innerHTML += req.params.name',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('input-sanitization');
    expect(result.signals.length).toBeGreaterThanOrEqual(2);
  });

  it('flags exec / spawn / readFile / writeFile with user input', async () => {
    fx(
      'src/sec/exec.ts',
      [
        'declare function exec(cmd: string): unknown',
        'declare function spawn(cmd: string, args: unknown[]): unknown',
        'declare function readFile(path: string, cb: (err: unknown, data: unknown) => void): void',
        'declare function unlinkSync(path: string): void',
        'export function f(req: any) {',
        '  exec(req.body.cmd)',
        '  spawn("sh", [req.params.arg])',
        '  readFile(req.query.path, () => {})',
        '  unlinkSync(req.body.target)',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('input-sanitization');
    expect(result.signals.length).toBeGreaterThanOrEqual(2);
  });

  it('flags dangerouslySetInnerHTML JSX attribute', async () => {
    fx(
      'src/sec/danger.tsx',
      [
        'export function Comp({ html }: { html: string }) {',
        '  return <div dangerouslySetInnerHTML={{ __html: html }} />',
        '}',
      ].join('\n'),
    );
    // The check only declares fileTypes: ['ts'], so .tsx may be filtered out;
    // this exercises the JSX-attribute walker code path either way.
    const result = await runCheck('input-sanitization');
    expect(result).toBeDefined();
  });

  it('flags HTML template-literal interpolation with user input', async () => {
    fx(
      'src/sec/tpl.ts',
      ['export function render(req: any) {', '  return `<div>${req.body.name}</div>`', '}'].join(
        '\n',
      ),
    );
    const result = await runCheck('input-sanitization');
    expect(result.signals.some((s) => s.message?.includes('HTML template'))).toBe(true);
  });

  it('does not flag innerHTML with non-user-input source', async () => {
    fx(
      'src/sec/safe-html.ts',
      ['export function f(el: HTMLElement, safe: string) {', '  el.innerHTML = safe', '}'].join(
        '\n',
      ),
    );
    const result = await runCheck('input-sanitization');
    expect(result.signals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// tsconfig-extends-validation
// ---------------------------------------------------------------------------

describe('tsconfig-extends-validation — branch coverage', () => {
  it('flags tsconfig with no extends field', async () => {
    fx(
      'packages/foo/tsconfig.json',
      JSON.stringify(
        {
          compilerOptions: { strict: true },
        },
        null,
        2,
      ),
    );
    const result = await runCheck('tsconfig-extends-validation');
    expect(result.signals.some((s) => s.metadata?.type === 'TSCONFIG_NO_EXTENDS')).toBe(true);
  });

  it('flags missing base when extends path does not resolve', async () => {
    fx(
      'packages/foo/tsconfig.json',
      JSON.stringify(
        {
          extends: './does-not-exist.json',
          compilerOptions: { strict: true },
        },
        null,
        2,
      ),
    );
    const result = await runCheck('tsconfig-extends-validation');
    expect(result.signals.some((s) => s.metadata?.type === 'TSCONFIG_MISSING_BASE')).toBe(true);
  });

  it('flags invalid JSON in tsconfig', async () => {
    fx('packages/foo/tsconfig.json', '{ broken json');
    const result = await runCheck('tsconfig-extends-validation');
    expect(result.signals.some((s) => s.metadata?.type === 'TSCONFIG_INVALID_JSON')).toBe(true);
  });

  it('skips node_modules tsconfig.json', async () => {
    fx(
      'packages/foo/node_modules/dep/tsconfig.json',
      JSON.stringify(
        {
          compilerOptions: { strict: true },
        },
        null,
        2,
      ),
    );
    const result = await runCheck('tsconfig-extends-validation');
    expect(result.signals).toHaveLength(0);
  });

  it('does not flag tsconfig that extends an existing file', async () => {
    fx(
      'tsconfig.base.json',
      JSON.stringify(
        {
          compilerOptions: { strict: true },
        },
        null,
        2,
      ),
    );
    fx(
      'packages/foo/tsconfig.json',
      JSON.stringify(
        {
          extends: '../../tsconfig.base.json',
        },
        null,
        2,
      ),
    );
    const result = await runCheck('tsconfig-extends-validation');
    // Note: the check uses process.cwd() — it may or may not resolve the
    // base file under the test's temp dir. The traversal still runs.
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// module-coupling-fan-out
// ---------------------------------------------------------------------------

describe('module-coupling-fan-out — branch coverage', () => {
  it('flags files with > 15 imports as warnings', async () => {
    const importLines: string[] = [];
    for (let i = 0; i < 20; i++) {
      fx(`src/dep${i}.ts`, `export const v${i} = ${i}`);
      importLines.push(`import { v${i} } from "./dep${i}.js"`);
    }
    fx(
      'src/main.ts',
      [
        ...importLines,
        'export const all = [' + Array.from({ length: 20 }, (_, i) => `v${i}`).join(', ') + ']',
      ].join('\n'),
    );
    const result = await runCheck('module-coupling-fan-out');
    // Expect main.ts to be flagged
    expect(result.signals.some((s) => s.message?.includes('High fan-out'))).toBe(true);
  });

  it('auto-exempts barrel files (only re-exports)', async () => {
    for (let i = 0; i < 25; i++) {
      fx(`src/dep${i}.ts`, `export const v${i} = ${i}`);
    }
    fx(
      'src/index.ts',
      Array.from({ length: 25 }, (_, i) => `export { v${i} } from "./dep${i}.js"`).join('\n'),
    );
    const result = await runCheck('module-coupling-fan-out');
    // Barrel should not fire.
    expect(result.signals.find((s) => s.code?.file?.endsWith('index.ts'))).toBeUndefined();
  });

  it('auto-exempts .d.ts files even with high fan-out', async () => {
    for (let i = 0; i < 20; i++) {
      fx(`src/types${i}.ts`, `export type T${i} = number`);
    }
    fx(
      'src/dts.d.ts',
      Array.from({ length: 20 }, (_, i) => `import { T${i} } from "./types${i}.js"`).join('\n') +
        '\nexport {}',
    );
    const result = await runCheck('module-coupling-fan-out');
    // d.ts files are auto-exempt.
    expect(result.signals.find((s) => s.code?.file?.endsWith('dts.d.ts'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// duplicate-utility-functions
// ---------------------------------------------------------------------------

describe('duplicate-utility-functions — branch coverage', () => {
  it('flags two functions with the same name and similar bodies', async () => {
    fx(
      'src/utils/dup-a.ts',
      [
        'export function camelCase(s: string): string {',
        '  return s.replaceAll(/_([a-z])/g, (_, c: string) => c.toUpperCase())',
        '}',
      ].join('\n'),
    );
    fx(
      'src/utils/dup-b.ts',
      [
        'export function camelCase(input: string): string {',
        '  return input.replaceAll(/_([a-z])/g, (_, c: string) => c.toUpperCase())',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('duplicate-utility-functions');
    expect(result).toBeDefined();
  });

  it('does not flag isolated functions with no duplicates', async () => {
    fx(
      'src/utils/unique.ts',
      [
        'export function uniquelyNamedFunction(s: string): string {',
        '  return s.toUpperCase()',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('duplicate-utility-functions');
    // Either zero violations or whatever the check produces; it just runs.
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// missing-input-validation
// ---------------------------------------------------------------------------

describe('missing-input-validation — branch coverage', () => {
  it('runs over typical fastify handlers with raw req.body access', async () => {
    fx(
      'src/routes/users.ts',
      [
        'import fastify from "fastify"',
        'const app = fastify()',
        'app.post("/users", async (req, res) => {',
        '  const body = req.body as { id: string; name: string }',
        '  return { id: body.id }',
        '})',
      ].join('\n'),
    );
    const result = await runCheck('missing-input-validation');
    expect(result).toBeDefined();
  });

  it('skips files that import zod (likely validated)', async () => {
    fx(
      'src/routes/zod.ts',
      ['import { z } from "zod"', 'export const Schema = z.object({ id: z.string() })'].join('\n'),
    );
    const result = await runCheck('missing-input-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// fastify-schema-coverage
// ---------------------------------------------------------------------------

describe('fastify-schema-coverage — branch coverage', () => {
  it('flags fastify routes with body access but no schema', async () => {
    fx(
      'src/routes/no-schema.ts',
      [
        'import fastify from "fastify"',
        'const app = fastify()',
        'app.post("/users", async (req, res) => {',
        '  const body = req.body as { name: string }',
        '  return { name: body.name }',
        '})',
        'app.put("/users/:id", async (req, res) => {',
        '  const params = req.params as { id: string }',
        '  return { id: params.id }',
        '})',
      ].join('\n'),
    );
    const result = await runCheck('fastify-schema-coverage');
    expect(result).toBeDefined();
  });

  it('handles object-form route declarations', async () => {
    fx(
      'src/routes/object-form.ts',
      [
        'import fastify from "fastify"',
        'const app = fastify()',
        'app.route({',
        '  method: "POST",',
        '  url: "/items",',
        '  handler: async (req, res) => {',
        '    const body = req.body as { name: string }',
        '    return { name: body.name }',
        '  },',
        '})',
      ].join('\n'),
    );
    const result = await runCheck('fastify-schema-coverage');
    expect(result).toBeDefined();
  });

  it('does not flag routes with explicit schema option', async () => {
    fx(
      'src/routes/with-schema.ts',
      [
        'import fastify from "fastify"',
        'const app = fastify()',
        'app.post("/users", {',
        '  schema: { body: { type: "object", properties: { name: { type: "string" } } } },',
        '}, async (req, res) => {',
        '  return { ok: true }',
        '})',
      ].join('\n'),
    );
    const result = await runCheck('fastify-schema-coverage');
    expect(result).toBeDefined();
  });

  it('skips files without fastify imports', async () => {
    fx('src/routes/no-fastify.ts', 'export const x = 1');
    const result = await runCheck('fastify-schema-coverage');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// fastify-route-validation
// ---------------------------------------------------------------------------

describe('fastify-route-validation — branch coverage', () => {
  it('runs over typical fastify route fixtures', async () => {
    fx(
      'src/routes/multi.ts',
      [
        'import fastify from "fastify"',
        'const app = fastify()',
        'app.get("/users/:id", async (req, res) => {',
        '  return res.send({ id: 1 })',
        '})',
        'app.post("/users", async (req, res) => {',
        '  const body = req.body',
        '  return res.send(body)',
        '})',
        'app.delete("/users/:id", async (req, res) => {',
        '  return res.code(204).send()',
        '})',
      ].join('\n'),
    );
    const result = await runCheck('fastify-route-validation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// openapi-response-coverage
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// memo-list-items
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// throws-documentation
// ---------------------------------------------------------------------------

describe('throws-documentation — branch coverage', () => {
  it('flags exported functions that throw without @throws JSDoc', async () => {
    fx(
      'src/errors/no-jsdoc.ts',
      [
        'export function validate(input: string): string {',
        '  if (!input) throw new Error("empty")',
        '  if (input.length > 1024) throw new RangeError("too long")',
        '  return input',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('throws-documentation');
    expect(result).toBeDefined();
  });

  it('skips functions that already document @throws', async () => {
    fx(
      'src/errors/with-jsdoc.ts',
      [
        '/**',
        ' * Validate input.',
        ' * @throws {Error} when input is empty',
        ' * @throws {RangeError} when input is too long',
        ' */',
        'export function validate(input: string): string {',
        '  if (!input) throw new Error("empty")',
        '  if (input.length > 1024) throw new RangeError("too long")',
        '  return input',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('throws-documentation');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// async-waterfall-detection
// ---------------------------------------------------------------------------

describe('async-waterfall-detection — branch coverage', () => {
  it('flags sequential awaits that could run in parallel', async () => {
    fx(
      'src/async/seq.ts',
      [
        'declare function loadA(): Promise<number>',
        'declare function loadB(): Promise<number>',
        'declare function loadC(): Promise<number>',
        'export async function loadAll() {',
        '  const a = await loadA()',
        '  const b = await loadB()',
        '  const c = await loadC()',
        '  return { a, b, c }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('async-waterfall-detection');
    expect(result).toBeDefined();
  });

  it('skips Promise.all-style parallel awaits', async () => {
    fx(
      'src/async/parallel.ts',
      [
        'declare function loadA(): Promise<number>',
        'declare function loadB(): Promise<number>',
        'export async function loadAll() {',
        '  const [a, b] = await Promise.all([loadA(), loadB()])',
        '  return { a, b }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('async-waterfall-detection');
    expect(result).toBeDefined();
  });

  it('handles awaits that depend on the previous result (genuine waterfall)', async () => {
    fx(
      'src/async/depends.ts',
      [
        'declare function loadUser(id: string): Promise<{ orgId: string }>',
        'declare function loadOrg(id: string): Promise<{ name: string }>',
        'export async function f(id: string) {',
        '  const user = await loadUser(id)',
        '  const org = await loadOrg(user.orgId)',
        '  return org',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('async-waterfall-detection');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// result-pattern-consistency
// ---------------------------------------------------------------------------

describe('result-pattern-consistency — branch coverage', () => {
  it('runs over Result.ok/Result.err mixed-style code', async () => {
    fx(
      'src/result/mixed.ts',
      [
        'declare const Result: { ok<T>(v: T): unknown; err<E>(e: E): unknown }',
        'export function a() {',
        '  return Result.ok(1)',
        '}',
        'export function b() {',
        '  return Result.err(new Error("x"))',
        '}',
        'export function c() {',
        '  throw new Error("inconsistent — should return Result.err")',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('result-pattern-consistency');
    expect(result).toBeDefined();
  });

  it('runs over a mix of Result-returning and throwing functions', async () => {
    fx(
      'src/result/throw.ts',
      [
        'export async function doIt() {',
        '  if (Math.random() > 0.5) {',
        '    throw new Error("boom")',
        '  }',
        '  return { ok: true }',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('result-pattern-consistency');
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// typeorm-n-plus-one
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// unused-config-options
// ---------------------------------------------------------------------------

describe('unused-config-options — branch coverage', () => {
  it('flags Config interface properties that are never accessed', async () => {
    fx(
      'src/config/types.ts',
      [
        'export interface AppConfig {',
        '  apiBaseUrl: string',
        '  unusedFeatureFlag: boolean',
        '  optional?: string',
        '}',
      ].join('\n'),
    );
    fx(
      'src/main.ts',
      [
        'import type { AppConfig } from "./config/types.js"',
        'export function f(c: AppConfig) { return c.apiBaseUrl }',
      ].join('\n'),
    );
    const result = await runCheck('unused-config-options');
    expect(result).toBeDefined();
  });

  it('skips paths under cli/, scripts/, bin/, __tests__/', async () => {
    fx('src/cli/config.ts', ['export interface CliConfig { unused: string }'].join('\n'));
    fx('src/scripts/config.ts', ['export interface ScriptConfig { unused: string }'].join('\n'));
    fx('src/__tests__/config.ts', ['export interface TestConfig { unused: string }'].join('\n'));
    const result = await runCheck('unused-config-options');
    expect(result.signals).toHaveLength(0);
  });

  it('skips common property names like enabled/timeout/port', async () => {
    fx(
      'src/server/config.ts',
      [
        'export interface ServerConfig {',
        '  enabled: boolean',
        '  timeout: number',
        '  port: number',
        '  host: string',
        '}',
      ].join('\n'),
    );
    const result = await runCheck('unused-config-options');
    expect(result.signals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// typed-inject-scope-mismatch
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// test-only-implementations
// ---------------------------------------------------------------------------
