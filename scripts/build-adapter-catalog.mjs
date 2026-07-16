#!/usr/bin/env node
/**
 * @fileoverview Generate the CLI-bundled first-party External Tool Adapter catalog.
 *
 * `opensip tools list --available [--lang <l>]` must describe adapters the user has
 * NOT installed yet — whose `package.json` is not on disk. So the CLI ships a
 * projection of every first-party `@opensip-cli/tool-*` adapter's manifest,
 * generated here from those manifests (the single source of truth: adapter
 * `tool.ts` → `opensipTools` via build-tool-command-manifests → this catalog).
 *
 * Usage:
 *   node scripts/build-adapter-catalog.mjs           # write the generated module
 *   node scripts/build-adapter-catalog.mjs --check    # CI drift gate (exit 1 on drift)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(
  REPO_ROOT,
  'packages',
  'cli',
  'src',
  'commands',
  'tools',
  'first-party-adapters.generated.ts',
);
const MAX_ADAPTERS = 128;
const MAX_ID_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 512;
const MAX_ALIASES = 16;
const MAX_LANGUAGES = 6;
const LOWER_KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CONTROL_CHARACTER = /\p{Cc}/u;
const NETWORK_VALUES = new Set(['local-only', 'networked']);
const LANGUAGE_VALUES = new Set(['typescript', 'rust', 'python', 'go', 'java', 'cpp']);

function failValidation(message) {
  throw new Error(`[build-adapter-catalog] invalid adapter catalog: ${message}`);
}

function assertBoundedKebab(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) {
    failValidation(`${label} must be a non-empty string of at most ${MAX_ID_LENGTH} characters`);
  }
  if (!LOWER_KEBAB.test(value)) {
    failValidation(`${label} must be lowercase kebab-case`);
  }
}

function boundedArraySnapshot(value, label, maximum) {
  if (!Array.isArray(value)) failValidation(`${label} must be an array`);
  const count = value.length;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    failValidation(`${label} must have a valid array length`);
  }
  if (count > maximum) {
    failValidation(`${label} must contain at most ${maximum} entries`);
  }
  return Array.from({ length: count }, (_, index) => value[index]);
}

function compareCodePoints(left, right) {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

/**
 * Validate the bounded release projection and derive its command hints.
 * Returns a fresh array sorted by the validated ASCII adapter id.
 */
export function validateAdapterEntries(entries) {
  const entryInputs = boundedArraySnapshot(entries, 'catalog', MAX_ADAPTERS);

  const ids = new Set();
  const packages = new Set();
  const validated = entryInputs.map((entry, index) => {
    const label = `entries[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      failValidation(`${label} must be an object`);
    }

    const {
      id,
      pkg,
      description,
      network,
      languages: languageInputs,
      aliases: aliasInputs,
    } = entry;
    assertBoundedKebab(id, `${label}.id`);
    if (ids.has(id)) failValidation(`${label}.id duplicates ${id}`);
    ids.add(id);

    const expectedPackage = `@opensip-cli/tool-${id}`;
    if (packages.has(pkg)) failValidation(`${label}.pkg duplicates ${String(pkg)}`);
    if (pkg !== expectedPackage) {
      failValidation(`${label}.pkg must equal ${expectedPackage}`);
    }
    packages.add(pkg);

    if (
      typeof description !== 'string' ||
      description.length > MAX_DESCRIPTION_LENGTH ||
      CONTROL_CHARACTER.test(description)
    ) {
      failValidation(
        `${label}.description must be control-free and at most ${MAX_DESCRIPTION_LENGTH} characters`,
      );
    }
    if (!NETWORK_VALUES.has(network)) {
      failValidation(`${label}.network must be local-only or networked`);
    }

    const languages = boundedArraySnapshot(languageInputs, `${label}.languages`, MAX_LANGUAGES);
    const uniqueLanguages = new Set();
    for (const language of languages) {
      if (!LANGUAGE_VALUES.has(language)) {
        failValidation(`${label}.languages contains unsupported language ${String(language)}`);
      }
      if (uniqueLanguages.has(language)) {
        failValidation(`${label}.languages contains duplicate ${String(language)}`);
      }
      uniqueLanguages.add(language);
    }

    const aliases = boundedArraySnapshot(aliasInputs, `${label}.aliases`, MAX_ALIASES);
    const uniqueAliases = new Set();
    for (const alias of aliases) {
      assertBoundedKebab(alias, `${label}.aliases[]`);
      if (uniqueAliases.has(alias)) {
        failValidation(`${label}.aliases contains duplicate ${alias}`);
      }
      uniqueAliases.add(alias);
    }

    return {
      pkg,
      id,
      command: `opensip ${id}`,
      description,
      network,
      languages: [...languages],
      aliases: [...aliases],
    };
  });

  return validated.sort(compareCodePoints);
}

/** Scan `packages/tool-*` for external-tool adapters (opensipTools.kind === 'tool'). */
function adapterEntries() {
  const pkgDir = join(REPO_ROOT, 'packages');
  const entries = [];
  for (const name of readdirSync(pkgDir)) {
    if (!name.startsWith('tool-')) continue;
    const pkgPath = join(pkgDir, name, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const ot = pkg.opensipTools;
    if (ot?.kind !== 'tool') continue; // skips tool-test-kit
    const id = ot.identity?.name ?? name.replace(/^tool-/, '');
    const networked = (ot.requires ?? []).some((r) => r.resource === 'network');
    entries.push({
      pkg: pkg.name,
      id,
      description: pkg.description ?? ot.identity?.name ?? id,
      network: networked ? 'networked' : 'local-only',
      languages: [...(ot.languages ?? [])].sort(),
      aliases: [...(ot.identity?.aliases ?? [])],
    });
  }
  return entries;
}

/** Render a string array as a single-quoted TS array literal (no nested templates). */
function quotedArray(values) {
  return `[${values.map((v) => "'" + v + "'").join(', ')}]`;
}

function render(entries) {
  const rows = entries
    .map((e) => {
      const langs = quotedArray(e.languages);
      const aliases = quotedArray(e.aliases);
      return [
        '  {',
        `    pkg: '${e.pkg}',`,
        `    id: '${e.id}',`,
        `    command: '${e.command}',`,
        `    description: ${JSON.stringify(e.description)},`,
        `    network: '${e.network}',`,
        `    languages: ${langs},`,
        `    aliases: ${aliases},`,
        '  },',
      ].join('\n');
    })
    .join('\n');
  return `// GENERATED by scripts/build-adapter-catalog.mjs — DO NOT EDIT BY HAND.
// Run \`pnpm adapter-catalog\` to regenerate; \`pnpm adapter-catalog:check\` gates drift.
// Source of truth: each adapter's tool.ts → opensipTools (build-tool-command-manifests).

/** One installable first-party External Tool Adapter, projected from its manifest. */
export interface FirstPartyAdapter {
  /** npm package to \`opensip tools install\` (e.g. \`@opensip-cli/tool-cppcheck\`). */
  readonly pkg: string;
  /** The tool id / primary command verb (\`cppcheck\`). */
  readonly id: string;
  /** The install-and-run hint command (\`opensip cppcheck\`). */
  readonly command: string;
  readonly description: string;
  readonly network: 'local-only' | 'networked';
  /** Canonical language ids the scanner covers; \`[]\` = polyglot (matches every --lang). */
  readonly languages: readonly string[];
  readonly aliases: readonly string[];
}

export const FIRST_PARTY_ADAPTERS: readonly FirstPartyAdapter[] = [
${rows}
];
`;
}

function main() {
  const entries = validateAdapterEntries(adapterEntries());
  const rendered = render(entries);
  const check = process.argv.includes('--check');

  if (check) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (current !== rendered) {
      console.error(
        `[build-adapter-catalog] DRIFT: first-party-adapters.generated.ts is stale.\n` +
          `  Run \`pnpm adapter-catalog\` and commit the result.`,
      );
      process.exit(1);
    }
    console.log(`[build-adapter-catalog] catalog in sync (${entries.length} adapters).`);
  } else {
    writeFileSync(OUT, rendered);
    console.log(`[build-adapter-catalog] wrote ${entries.length} adapters → ${OUT}`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) main();
