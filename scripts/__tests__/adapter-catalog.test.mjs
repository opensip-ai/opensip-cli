import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { validateAdapterEntries } from '../build-adapter-catalog.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATOR_URL = pathToFileURL(join(REPO_ROOT, 'scripts/build-adapter-catalog.mjs')).href;
const GENERATED_CATALOG = join(
  REPO_ROOT,
  'packages/cli/src/commands/tools/first-party-adapters.generated.ts',
);

function entry(id = 'ruff', overrides = {}) {
  return {
    pkg: `@opensip-cli/tool-${id}`,
    id,
    description: `${id} adapter`,
    network: 'local-only',
    languages: ['python'],
    aliases: [],
    ...overrides,
  };
}

test('validates entries, derives commands, and sorts by raw code point', () => {
  const validated = validateAdapterEntries([
    entry('zeta', { command: 'unsafe manifest command' }),
    entry('alpha', { languages: [], aliases: ['a'] }),
    entry('middle', { network: 'networked', languages: ['go'] }),
  ]);

  assert.deepEqual(
    validated.map((adapter) => adapter.id),
    ['alpha', 'middle', 'zeta'],
  );
  assert.deepEqual(
    validateAdapterEntries(validated.toReversed()).map((adapter) => adapter.id),
    ['alpha', 'middle', 'zeta'],
  );
  assert.equal(validated[2].command, 'opensip zeta');
});

test('is import-safe and does not execute the generator main body', () => {
  const modifiedBefore = statSync(GENERATED_CATALOG, { bigint: true }).mtimeNs;
  const imported = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `await import(${JSON.stringify(GENERATOR_URL)});`],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  assert.equal(imported.stderr, '');
  assert.equal(statSync(GENERATED_CATALOG, { bigint: true }).mtimeNs, modifiedBefore);
});

test('snapshots hostile arrays by bounded numeric index without using overrides', () => {
  const languages = ['python'];
  Object.defineProperty(languages, Symbol.iterator, {
    value: function* hostileLanguages() {
      yield 'ruby';
    },
  });
  const aliases = ['safe-alias'];
  Object.defineProperty(aliases, Symbol.iterator, {
    value: function* hostileAliases() {
      yield 'Not-Safe';
    },
  });
  const entries = [entry('ruff', { languages, aliases })];
  let descriptionReads = 0;
  Object.defineProperty(entries[0], 'description', {
    enumerable: true,
    get: () => {
      descriptionReads += 1;
      return descriptionReads === 1 ? 'safe adapter' : 'unsafe\u001B[31madapter';
    },
  });
  Object.defineProperties(entries, {
    map: {
      value: () => [entry('injected')],
    },
    [Symbol.iterator]: {
      value: function* hostileEntries() {
        yield entry('injected');
      },
    },
  });

  const validated = validateAdapterEntries(entries);

  assert.deepEqual(
    validated.map((adapter) => adapter.id),
    ['ruff'],
  );
  assert.deepEqual(validated[0].languages, ['python']);
  assert.deepEqual(validated[0].aliases, ['safe-alias']);
  assert.equal(validated[0].description, 'safe adapter');
  assert.equal(descriptionReads, 1);
});

test('reads proxy lengths once and rejects non-numeric lengths without coercion', () => {
  let reads = 0;
  const stateful = new Proxy([entry('ruff')], {
    get: (target, property, receiver) => {
      if (property === 'length') {
        reads += 1;
        return reads === 1 ? 1 : 129;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  assert.deepEqual(
    validateAdapterEntries(stateful).map((adapter) => adapter.id),
    ['ruff'],
  );
  assert.equal(reads, 1);

  let coercions = 0;
  const invalidLength = new Proxy([], {
    get: (target, property, receiver) =>
      property === 'length'
        ? {
            valueOf: () => {
              coercions += 1;
              return 0;
            },
          }
        : Reflect.get(target, property, receiver),
  });
  assert.throws(() => validateAdapterEntries(invalidLength), /valid array length/);
  assert.equal(coercions, 0);
});

test('rejects duplicate ids and packages', () => {
  assert.throws(() => validateAdapterEntries([entry('ruff'), entry('ruff')]), /id duplicates ruff/);
  assert.throws(
    () =>
      validateAdapterEntries([entry('ruff'), entry('bandit', { pkg: '@opensip-cli/tool-ruff' })]),
    /pkg duplicates @opensip-cli\/tool-ruff/,
  );
});

test('rejects control-bearing descriptions and package mismatches', () => {
  assert.throws(
    () => validateAdapterEntries([entry('ruff', { description: 'unsafe\u001B[31mtext' })]),
    /description must be control-free/,
  );
  assert.throws(
    () => validateAdapterEntries([entry('ruff', { pkg: '@example/tool-ruff' })]),
    /pkg must equal @opensip-cli\/tool-ruff/,
  );
});

test('rejects unknown or duplicate languages and invalid network values', () => {
  assert.throws(
    () => validateAdapterEntries([entry('ruff', { languages: ['ruby'] })]),
    /unsupported language ruby/,
  );
  assert.throws(
    () => validateAdapterEntries([entry('ruff', { languages: ['python', 'python'] })]),
    /languages contains duplicate python/,
  );
  assert.throws(
    () => validateAdapterEntries([entry('ruff', { network: 'sometimes' })]),
    /network must be local-only or networked/,
  );
});

test('rejects oversize ids, descriptions, language lists, and catalogs', () => {
  assert.throws(
    () => validateAdapterEntries([entry('x'.repeat(65))]),
    /id must be a non-empty string of at most 64/,
  );
  assert.throws(
    () => validateAdapterEntries([entry('ruff', { description: 'x'.repeat(513) })]),
    /description must be control-free and at most 512/,
  );
  assert.throws(
    () =>
      validateAdapterEntries([
        entry('ruff', {
          languages: ['typescript', 'rust', 'python', 'go', 'java', 'cpp', 'python'],
        }),
      ]),
    /languages must contain at most 6 entries/,
  );
  assert.throws(
    () => validateAdapterEntries(Array.from({ length: 129 }, (_, index) => entry(`tool-${index}`))),
    /catalog must contain at most 128 entries/,
  );
});

test('rejects unsafe, duplicate, and oversize aliases', () => {
  assert.throws(
    () => validateAdapterEntries([entry('ruff', { aliases: ['Not-Safe'] })]),
    /aliases\[\] must be lowercase kebab-case/,
  );
  assert.throws(
    () => validateAdapterEntries([entry('ruff', { aliases: ['fast', 'fast'] })]),
    /aliases contains duplicate fast/,
  );
  assert.throws(
    () => validateAdapterEntries([entry('ruff', { aliases: ['x'.repeat(65)] })]),
    /aliases\[\] must be a non-empty string of at most 64/,
  );
  assert.throws(
    () =>
      validateAdapterEntries([
        entry('ruff', {
          aliases: Array.from({ length: 17 }, (_, index) => `alias-${index}`),
        }),
      ]),
    /aliases must contain at most 16 entries/,
  );
});
