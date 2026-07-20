import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findOccurrence, runFixture, writeFixture } from './acceptance/_fixture-runner.js';

import type { Catalog } from '@opensip-cli/graph';

describe('literal property-name call resolution', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'graph-computed-property-'));
  let catalog: Catalog;

  beforeAll(async () => {
    writeFixture(fixtureDir, {
      'source.ts':
        `export class Service {\n` +
        `  ['run']() { return 1; }\n` +
        `  get #secret() { return 3; }\n` +
        `}\n` +
        `export const handlers = { 'handle': () => 2 };\n`,
      'caller.ts':
        `import { Service, handlers } from './source.js';\n` +
        `export function caller() { return new Service().run() + handlers.handle(); }\n`,
    });
    catalog = await runFixture(fixtureDir);
  });

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('uses the runtime string value for a computed method name', () => {
    const caller = findOccurrence(catalog, (occurrence) => occurrence.simpleName === 'caller');
    const method = findOccurrence(
      catalog,
      (occurrence) => occurrence.kind === 'method' && occurrence.simpleName === 'run',
    );
    const edge = caller?.calls.find((call) => call.text.includes('.run()'));

    expect(method).toBeDefined();
    expect(edge?.to).toEqual([method!.bodyHash]);
  });

  it('uses a string-literal object property as its callable name', () => {
    const caller = findOccurrence(catalog, (occurrence) => occurrence.simpleName === 'caller');
    const handler = findOccurrence(
      catalog,
      (occurrence) => occurrence.kind === 'arrow' && occurrence.simpleName === 'handle',
    );
    const edge = caller?.calls.find((call) => call.text.includes('handlers.handle()'));

    expect(handler).toBeDefined();
    expect(edge?.to).toEqual([handler!.bodyHash]);
  });

  it('inventories ECMAScript private accessors', () => {
    const getter = findOccurrence(
      catalog,
      (occurrence) => occurrence.kind === 'getter' && occurrence.simpleName === '#secret',
    );

    expect(getter).toMatchObject({ visibility: 'private' });
  });
});
