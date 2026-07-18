/**
 * Host-owned starter configuration model — cache (no-init) and Init share
 * one pure semantics surface. Parity is defined at parsed/composed document
 * level, not YAML formatting.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CLI_SUPPORTED_SCHEMA_VERSION, ToolRegistry, resolveToolHooks } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { BUNDLED_TOOLS } from '../../__tests__/test-utils/bundled-tools.js';
import {
  generateConfig,
  generateConfigFromRenderedScaffolds,
} from '../../commands/init/config-templates.js';
import { ALL_LANGUAGES, type SupportedLanguage } from '../../commands/init/language-detection.js';
import { enumerateToolScaffolds, type ToolScaffold } from '../../commands/shared.js';
import { composeAndValidateToolConfig } from '../config-and-capabilities.js';
import {
  STARTER_GLOBAL_EXCLUDES,
  buildStarterConfigDocument,
  buildStarterDocumentHeaderInput,
  canonicalStarterLanguages,
  starterTargetTemplate,
  starterTargetTemplates,
} from '../starter-config.js';

function realRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const tool of BUNDLED_TOOLS) reg.register(tool);
  return reg;
}

function scaffolds(): ToolScaffold[] {
  return BUNDLED_TOOLS.filter((t) => t.pluginLayout !== undefined).map((t) => {
    const hooks = resolveToolHooks(t);
    return {
      identity: {
        stableId: t.metadata.id,
        name: t.metadata.name,
        version: t.metadata.version,
      },
      layout: t.pluginLayout!,
      scaffoldExamples: hooks.scaffoldExamples,
      stableExampleIds: hooks.stableExampleIds,
      scaffoldConfigBlock: hooks.scaffoldConfigBlock,
    };
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Host-owned projection used for semantic parity (not tool namespaces). */
function hostProjection(document: unknown): {
  schemaVersion: unknown;
  globalExcludes: unknown;
  targets: unknown;
} {
  if (!isPlainRecord(document)) {
    throw new Error('expected plain config document');
  }
  return {
    schemaVersion: document['schemaVersion'],
    globalExcludes: document['globalExcludes'],
    targets: document['targets'],
  };
}

const LANGUAGE_CASES: readonly {
  readonly name: string;
  readonly languages: readonly SupportedLanguage[];
}[] = [
  ...ALL_LANGUAGES.map((language) => ({
    name: `single:${language}`,
    languages: [language] as const,
  })),
  {
    name: 'polyglot:typescript+python',
    languages: ['python', 'typescript'] as const, // non-canonical input order
  },
  {
    name: 'polyglot:all',
    languages: [...ALL_LANGUAGES].reverse(),
  },
];

describe('starter-config host model', () => {
  it('exposes the eleven canonical global excludes in stable order', () => {
    expect(STARTER_GLOBAL_EXCLUDES).toEqual([
      '**/.git/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/target/**',
      '**/__pycache__/**',
      '**/.venv/**',
      '**/venv/**',
    ]);
    expect(STARTER_GLOBAL_EXCLUDES).toHaveLength(11);
  });

  it('canonicalizes language sets into ALL_LANGUAGES order and dedupes', () => {
    expect(canonicalStarterLanguages(['python', 'typescript', 'python'])).toEqual([
      'typescript',
      'python',
    ]);
    expect(canonicalStarterLanguages([...ALL_LANGUAGES].reverse())).toEqual([...ALL_LANGUAGES]);
  });

  it('projects one target per language with backend concerns default', () => {
    for (const language of ALL_LANGUAGES) {
      const template = starterTargetTemplate(language);
      expect(template.languages).toEqual([language]);
      expect(template.name).toContain(language === 'cpp' ? 'cpp' : language);
      expect(template.include.length).toBeGreaterThan(0);
      expect(template.exclude.length).toBeGreaterThan(0);
    }
    expect(starterTargetTemplates(['go', 'rust']).map((t) => t.name)).toEqual([
      'go-source',
      'rust-source',
    ]);
  });

  it('builds DocumentHeaderInput with schema, full excludes, and canonical targets', () => {
    const header = buildStarterDocumentHeaderInput(['java', 'typescript']);
    expect(header.schemaVersion).toBe(CLI_SUPPORTED_SCHEMA_VERSION);
    expect(header.globalExcludes).toEqual([...STARTER_GLOBAL_EXCLUDES]);
    expect(header.targets.map((t) => t.name)).toEqual(['typescript-source', 'java-source']);
  });

  it('builds an in-memory document with the same host projection as the header', () => {
    const languages: readonly SupportedLanguage[] = ['rust', 'go'];
    const document = buildStarterConfigDocument(languages);
    const header = buildStarterDocumentHeaderInput(languages);
    expect(document['schemaVersion']).toBe(header.schemaVersion);
    expect(document['globalExcludes']).toEqual(header.globalExcludes);
    const targets = document['targets'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(targets)).toEqual(header.targets.map((t) => t.name));
    for (const template of header.targets) {
      const entry = targets[template.name]!;
      expect(entry['description']).toBe(template.description);
      expect(entry['languages']).toEqual([...template.languages]);
      expect(entry['concerns']).toEqual(['backend']);
      expect(entry['include']).toEqual([...template.include]);
      expect(entry['exclude']).toEqual([...template.exclude]);
    }
    // Tool namespaces must not be copied into the host model.
    expect(document).not.toHaveProperty('fitness');
    expect(document).not.toHaveProperty('graph');
    expect(document).not.toHaveProperty('simulation');
  });
});

describe('starter-config cache/Init semantic parity', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'starter-parity-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  for (const { name, languages } of LANGUAGE_CASES) {
    it(`parsed host semantics match for ${name}`, () => {
      const ordered = canonicalStarterLanguages(languages);
      const noInitDocument = buildStarterConfigDocument(languages);

      const configPath = join(dir, `opensip-cli.config.${name.replaceAll(':', '-')}.yml`);
      writeFileSync(configPath, generateConfig(languages, scaffolds()), 'utf8');

      const noInitValidated = composeAndValidateToolConfig({
        tools: realRegistry(),
        configPath: undefined,
        rawDocumentOverride: noInitDocument,
        env: {},
      });
      const initValidated = composeAndValidateToolConfig({
        tools: realRegistry(),
        configPath,
        env: {},
      });

      // Host-owned fields must be identical after composition.
      expect(hostProjection(initValidated.document)).toEqual(
        hostProjection(noInitValidated.document),
      );
      expect(hostProjection(noInitValidated.document).globalExcludes).toEqual([
        ...STARTER_GLOBAL_EXCLUDES,
      ]);
      expect(hostProjection(noInitValidated.document).schemaVersion).toBe(
        CLI_SUPPORTED_SCHEMA_VERSION,
      );

      // Target names follow canonical language order regardless of input order.
      const targets = hostProjection(noInitValidated.document).targets;
      expect(isPlainRecord(targets)).toBe(true);
      if (isPlainRecord(targets)) {
        expect(Object.keys(targets)).toEqual(
          ordered.map((language) => starterTargetTemplate(language).name),
        );
      }

      // Bundled Tool effective defaults match: no-init uses schema defaults;
      // Init scaffold blocks resolve to the same effective tool config.
      expect(initValidated.config).toEqual(noInitValidated.config);
      expect(initValidated.config).toBeDefined();
    });
  }

  it('Init YAML formatting may differ but parse equals the starter document host fields', () => {
    const languages: readonly SupportedLanguage[] = ['typescript'];
    const yaml = generateConfig(languages, scaffolds());
    const parsed = parseYaml(yaml);
    expect(hostProjection(parsed)).toEqual(hostProjection(buildStarterConfigDocument(languages)));
    // Scaffold blocks are additive for Init and absent from the pure host model.
    expect(yaml).toContain('fitness:');
    expect(buildStarterConfigDocument(languages)).not.toHaveProperty('fitness');
  });

  it('callback-free scaffold snapshot keeps Init bytes stable', () => {
    const live = scaffolds();
    const rendered = enumerateToolScaffolds(live, { languages: ALL_LANGUAGES });
    expect(generateConfigFromRenderedScaffolds(ALL_LANGUAGES, rendered)).toBe(
      generateConfig(ALL_LANGUAGES, live),
    );
  });
});
