import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { LanguageRegistry, RunScope, runWithScope } from '@opensip-cli/core';
import { typescriptAdapter } from '@opensip-cli/lang-typescript';
import { fitnessTestFileCache } from '@opensip-cli/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checks } from '../index.js';

const languages = new LanguageRegistry();
languages.register(typescriptAdapter);
const scope = new RunScope({ languages });
Object.assign(scope, { fitness: { fileCache: fitnessTestFileCache } });

let cwd: string;
let targetFiles: string[];

function fixture(relativePath: string, content: string): void {
  const absolutePath = join(cwd, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  targetFiles.push(absolutePath);
}

async function runCheck(slug: string) {
  const check = checks.find((candidate) => candidate.config.slug === slug);
  if (!check) throw new Error(`check not found: ${slug}`);
  await fitnessTestFileCache.prewarm(cwd, ['**/*']);
  return runWithScope(scope, () => check.run(cwd, { targetFiles }));
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'opensip-ast-wrapper-regression-'));
  targetFiles = [];
});

afterEach(() => {
  fitnessTestFileCache.clear();
  rmSync(cwd, { recursive: true, force: true });
});

describe('drizzle-orm-migration-guardrails AST wrappers', () => {
  it('detects optional, computed, and parenthesized dangerous SQL forms', async () => {
    fixture(
      'src/db/migrations/001_wrapped.ts',
      [
        'declare const db: { sql?: { unsafe(query: string): unknown } }',
        'declare const sql: { unsafe(query: string): unknown }',
        'db.sql?.unsafe("SELECT * FROM users")',
        'sql["unsafe"]("SELECT * FROM users")',
        'export const migration = (sql)`DROP TABLE users`',
      ].join('\n'),
    );

    const result = await runCheck('drizzle-orm-migration-guardrails');

    expect(
      result.signals.filter((signal) => signal.metadata?.type === 'MIGRATION_GUARDRAIL'),
    ).toHaveLength(3);
  });
});

describe('fastify-schema-coverage AST wrappers', () => {
  it('analyzes wrapped object routes with computed literal method and URL keys', async () => {
    fixture(
      'src/routes/wrapped-object.ts',
      [
        'declare const app: { route(options: object): void }',
        'app.route(({',
        '  ["method"]: ("POST" as const),',
        '  ["url"]: ("/items/:id" as const),',
        '  handler: async (request: { body: unknown }) => request.body,',
        '} as const))',
      ].join('\n'),
    );

    const result = await runCheck('fastify-schema-coverage');

    expect(result.signals.map((signal) => signal.metadata?.type)).toContain('missing-schema');
  });

  it('accepts fully covered shorthand options behind wrappers and computed keys', async () => {
    fixture(
      'src/routes/wrapped-shorthand.ts',
      [
        'declare const app: { post(path: string, options: object, handler: Function): void }',
        'app.post(("/items/:id" as const), (({',
        '  ["schema"]: ({',
        '    ["body"]: { type: "object" },',
        '    ["params"]: { type: "object" },',
        '    ["response"]: { 200: { type: "object" } },',
        '  } as const),',
        '} as const)), async (request: { body: unknown }) => request.body)',
      ].join('\n'),
    );

    const result = await runCheck('fastify-schema-coverage');

    expect(result.signals).toHaveLength(0);
  });

  it('accepts fully covered wrapped object routes with computed schema keys', async () => {
    fixture(
      'src/routes/covered-object.ts',
      [
        'declare const app: { route(options: object): void }',
        'app.route(({',
        '  ["method"]: ("POST" as const),',
        '  ["url"]: ("/items/:id" as const),',
        '  ["schema"]: ({',
        '    ["body"]: { type: "object" },',
        '    ["params"]: { type: "object" },',
        '    ["response"]: { 200: { type: "object" } },',
        '  } as const),',
        '  handler: async (request: { body: unknown }) => request.body,',
        '} as const))',
      ].join('\n'),
    );

    const result = await runCheck('fastify-schema-coverage');

    expect(result.signals).toHaveLength(0);
  });
});
