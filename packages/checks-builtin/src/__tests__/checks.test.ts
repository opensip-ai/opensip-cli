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

  it('skips attachDomainContext (sync OTel helper)', async () => {
    const file = path.join(tmpDir, 'a.ts');
    fs.writeFileSync(
      file,
      `async function handle() {
         attachDomainContext({ tenantId: 'a' });
       }`,
    );
    const result = await check!.run(tmpDir, { targetFiles: [file] });
    expect(result.warnings).toBe(0);
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
});
