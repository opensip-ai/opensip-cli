import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { LanguageRegistry, RunScope, runWithScope } from '@opensip-cli/core';
import { typescriptAdapter } from '@opensip-cli/lang-typescript';
import { fitnessTestFileCache } from '@opensip-cli/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fastifySchemaCoverage } from '../checks/quality/api/fastify-schema-coverage.js';
import { analyzeFileForErrorHandlingQuality } from '../checks/quality/patterns/error-handling-quality.js';

const languages = new LanguageRegistry();
languages.register(typescriptAdapter);
const scope = new RunScope({ languages });
Object.assign(scope, { fitness: { fileCache: fitnessTestFileCache } });

let cwd: string;
let targetFile: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'opensip-regex-literal-regression-'));
  targetFile = join(cwd, 'src/routes/items.ts');
  mkdirSync(dirname(targetFile), { recursive: true });
});

afterEach(() => {
  fitnessTestFileCache.clear();
  rmSync(cwd, { recursive: true, force: true });
});

describe('regex literals cannot satisfy executable-code checks', () => {
  it('does not treat a Zod call written inside a regex as Fastify response validation', async () => {
    writeFileSync(
      targetFile,
      [
        'declare const fastify: { get(path: string, options: object, handler: Function): void }',
        'fastify.get("/items", { schema: {} }, async () => {',
        '  const documentationPattern = /ResultSchema.parse(value)/',
        '  return { ok: true, documentationPattern }',
        '})',
      ].join('\n'),
    );

    await fitnessTestFileCache.prewarm(cwd, ['**/*']);
    const result = await runWithScope(scope, () =>
      fastifySchemaCoverage.run(cwd, { targetFiles: [targetFile] }),
    );

    expect(result.signals.map((signal) => signal.metadata?.type)).toContain(
      'missing-response-schema',
    );
  });

  it('masks regex bodies when analyzing object-form Fastify routes', async () => {
    writeFileSync(
      targetFile,
      [
        'declare const fastify: { route(options: object): void }',
        'fastify.route({',
        '  method: "GET",',
        '  url: "/items",',
        '  schema: {},',
        '  handler: async () => {',
        '    const documentationPattern = /ResultSchema.parse(value)/',
        '    return { ok: true, documentationPattern }',
        '  },',
        '})',
      ].join('\n'),
    );

    await fitnessTestFileCache.prewarm(cwd, ['**/*']);
    const result = await runWithScope(scope, () =>
      fastifySchemaCoverage.run(cwd, { targetFiles: [targetFile] }),
    );

    expect(result.signals.map((signal) => signal.metadata?.type)).toContain(
      'missing-response-schema',
    );
  });

  it('continues to accept an actual Zod response parse call', async () => {
    writeFileSync(
      targetFile,
      [
        'declare const fastify: { get(path: string, options: object, handler: Function): void }',
        'declare const ResultSchema: { parse(value: unknown): unknown }',
        'fastify.get("/items", { schema: {} }, async () => {',
        '  return ResultSchema.parse({ ok: true })',
        '})',
      ].join('\n'),
    );

    await fitnessTestFileCache.prewarm(cwd, ['**/*']);
    const result = await runWithScope(scope, () =>
      fastifySchemaCoverage.run(cwd, { targetFiles: [targetFile] }),
    );

    expect(result.signals.map((signal) => signal.metadata?.type)).not.toContain(
      'missing-response-schema',
    );
  });

  it('does not treat a logger call written inside a regex as catch-block logging', () => {
    const content = [
      'export function load(): boolean {',
      '  try {',
      '    return work()',
      '  } catch (err) {',
      '    const documentationPattern = /logger.error(err)/',
      '    void documentationPattern',
      '    return false',
      '  }',
      '}',
    ].join('\n');

    const violations = analyzeFileForErrorHandlingQuality(content, 'src/services/load.ts');

    expect(violations.map((violation) => violation.match)).toContain('return false');
  });

  it('continues to accept an actual catch-block logger call', () => {
    const content = [
      'export function load(): boolean {',
      '  try {',
      '    return work()',
      '  } catch (err) {',
      '    logger.error(err)',
      '    return false',
      '  }',
      '}',
    ].join('\n');

    expect(analyzeFileForErrorHandlingQuality(content, 'src/services/load.ts')).toHaveLength(0);
  });
});
