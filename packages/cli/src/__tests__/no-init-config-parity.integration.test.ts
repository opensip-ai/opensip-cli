/**
 * Built-flow parity: no-init synthesis and first Init share starter semantics
 * for the same single-language and polyglot fixtures. Compared at parsed/
 * composed document level (languages, excludes, targets, Tool defaults),
 * not YAML formatting.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ToolRegistry, logger, resolveToolHooks } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composeAndValidateToolConfig } from '../bootstrap/config-and-capabilities.js';
import { synthesizeNoInitConfigDocument } from '../bootstrap/no-init-config.js';
import {
  STARTER_GLOBAL_EXCLUDES,
  buildStarterConfigDocument,
} from '../bootstrap/starter-config.js';
import { buildDatastoreLockContext } from '../bootstrap/state-lock-policy.js';
import { generateConfig } from '../commands/init/config-templates.js';
import {
  canonicalizeLanguages,
  resolveLanguages,
  type SupportedLanguage,
} from '../commands/init/language-detection.js';
import { executeInit } from '../commands/init.js';

import { BUNDLED_TOOLS } from './test-utils/bundled-tools.js';

import type { ToolScaffold } from '../commands/shared.js';

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

function hostProjection(document: unknown): {
  schemaVersion: unknown;
  globalExcludes: unknown;
  targets: unknown;
} {
  if (!isPlainRecord(document)) throw new Error('expected plain config document');
  return {
    schemaVersion: document['schemaVersion'],
    globalExcludes: document['globalExcludes'],
    targets: document['targets'],
  };
}

const FIXTURES: readonly {
  readonly name: string;
  readonly markers: readonly string[];
  readonly expectedLanguages: readonly SupportedLanguage[];
}[] = [
  {
    name: 'single-typescript',
    markers: ['tsconfig.json'],
    expectedLanguages: ['typescript'],
  },
  {
    name: 'single-rust',
    markers: ['Cargo.toml'],
    expectedLanguages: ['rust'],
  },
  {
    name: 'polyglot-ts-python-go',
    markers: ['tsconfig.json', 'pyproject.toml', 'go.mod'],
    expectedLanguages: ['typescript', 'python', 'go'],
  },
];

describe('no-init / Init config semantic parity (integration)', () => {
  let dir: string;
  let homeDir: string;
  let priorHome: string | undefined;

  beforeEach(() => {
    priorHome = process.env.HOME;
    homeDir = mkdtempSync(join(tmpdir(), 'parity-home-'));
    process.env.HOME = homeDir;
    dir = mkdtempSync(join(tmpdir(), 'no-init-init-parity-'));
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.name}: detection, no-init document, and Init scaffold share semantics`, async () => {
      for (const marker of fixture.markers) {
        const content =
          marker === 'go.mod'
            ? 'module example.com/x\n'
            : marker === 'Cargo.toml'
              ? '[package]\nname = "x"\n'
              : marker.endsWith('.json')
                ? '{}'
                : '';
        writeFileSync(join(dir, marker), content, 'utf8');
      }

      const resolution = resolveLanguages(dir, undefined);
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) return;
      expect(resolution.languages).toEqual(fixture.expectedLanguages);

      const synthesized = synthesizeNoInitConfigDocument(dir);
      expect(synthesized).toBeDefined();
      expect(synthesized!.languages).toEqual(fixture.expectedLanguages);
      expect(synthesized!.document).toEqual(
        buildStarterConfigDocument(fixture.expectedLanguages),
      );

      // YAML path uses the same starter model (no live disk Init required).
      const yaml = generateConfig(resolution.languages, scaffolds());
      const configPath = join(dir, 'opensip-cli.config.from-generate.yml');
      writeFileSync(configPath, yaml, 'utf8');

      const noInitValidated = composeAndValidateToolConfig({
        tools: realRegistry(),
        configPath: undefined,
        rawDocumentOverride: synthesized!.document,
        env: {},
      });
      const initYamlValidated = composeAndValidateToolConfig({
        tools: realRegistry(),
        configPath,
        env: {},
      });

      expect(hostProjection(initYamlValidated.document)).toEqual(
        hostProjection(noInitValidated.document),
      );
      expect(hostProjection(noInitValidated.document).globalExcludes).toEqual([
        ...STARTER_GLOBAL_EXCLUDES,
      ]);
      expect(initYamlValidated.config).toEqual(noInitValidated.config);

      // Full Init path: first scaffold on the fixture directory.
      const initResult = await executeInit({
        cwd: dir,
        json: false,
        debug: false,
        toolScaffolds: scaffolds(),
        datastoreLockContext: buildDatastoreLockContext(logger, {
          commandName: 'opensip init',
          cwd: dir,
        }),
      });
      expect(initResult.created).toBe(true);
      expect(initResult.languages).toEqual(fixture.expectedLanguages);
      expect(initResult.languageResolutionError).toBeUndefined();
      expect(initResult.ambiguousLanguageError).toBeUndefined();

      const onDiskValidated = composeAndValidateToolConfig({
        tools: realRegistry(),
        configPath: join(dir, 'opensip-cli.config.yml'),
        env: {},
      });
      expect(hostProjection(onDiskValidated.document)).toEqual(
        hostProjection(noInitValidated.document),
      );
      expect(onDiskValidated.config).toEqual(noInitValidated.config);
      expect(canonicalizeLanguages(initResult.languages ?? [])).toEqual(
        fixture.expectedLanguages,
      );
    });
  }
});
