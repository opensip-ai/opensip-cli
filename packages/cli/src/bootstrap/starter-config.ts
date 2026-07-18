/**
 * starter-config — one host-owned starter configuration model.
 *
 * Both no-init analysis (in-memory document) and `opensip init` (YAML header)
 * consume these pure helpers so host-owned starter semantics stay identical:
 * canonical language order, the eleven global excludes, and target templates.
 *
 * Tool configuration blocks remain Tool-owned (`Tool.scaffoldConfigBlock`) and
 * are never copied into this model. `@opensip-cli/config` stays generic: it
 * renders whatever header input the composition root supplies.
 */

import { CLI_SUPPORTED_SCHEMA_VERSION } from '@opensip-cli/core';

import {
  ALL_LANGUAGES,
  type SupportedLanguage,
} from '../commands/init/language-detection.js';

import type { DocumentHeaderInput, TargetTemplateInput } from '@opensip-cli/config';

/**
 * Canonical host starter global excludes shared by cache (no-init) and Init.
 * Order is part of the host contract — both paths project this exact list.
 */
export const STARTER_GLOBAL_EXCLUDES: readonly string[] = Object.freeze([
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

/**
 * Reorder + dedupe a language set into the host canonical starter order
 * (`ALL_LANGUAGES`). Unknown languages are dropped by construction because the
 * input type is already `SupportedLanguage`.
 */
export function canonicalStarterLanguages(
  languages: readonly SupportedLanguage[],
): readonly SupportedLanguage[] {
  const detected = new Set(languages);
  return ALL_LANGUAGES.filter((language) => detected.has(language));
}

/** One named target template for a single supported language. */
export function starterTargetTemplate(lang: SupportedLanguage): TargetTemplateInput {
  switch (lang) {
    case 'typescript': {
      return {
        name: 'typescript-source',
        description: 'TypeScript / TSX source code',
        languages: ['typescript'],
        include: [
          'src/**/*.ts',
          'src/**/*.tsx',
          'packages/*/src/**/*.ts',
          'packages/*/src/**/*.tsx',
        ],
        exclude: [
          '**/*.test.ts',
          '**/*.test.tsx',
          '**/__tests__/**',
          '**/node_modules/**',
          '**/dist/**',
        ],
      };
    }
    case 'rust': {
      return {
        name: 'rust-source',
        description: 'Rust source code',
        languages: ['rust'],
        include: ['src/**/*.rs', 'crates/**/*.rs', 'services/**/*.rs'],
        exclude: ['**/target/**'],
      };
    }
    case 'python': {
      return {
        name: 'python-source',
        description: 'Python source code',
        languages: ['python'],
        include: ['src/**/*.py', '**/*.py'],
        exclude: [
          '**/__pycache__/**',
          '**/.venv/**',
          '**/venv/**',
          '**/dist/**',
          '**/build/**',
          '**/*.egg-info/**',
        ],
      };
    }
    case 'go': {
      return {
        name: 'go-source',
        description: 'Go source code',
        languages: ['go'],
        include: ['**/*.go'],
        exclude: ['**/vendor/**', '**/_test.go'],
      };
    }
    case 'java': {
      return {
        name: 'java-source',
        description: 'Java source code',
        languages: ['java'],
        include: ['src/main/java/**/*.java', 'src/**/*.java'],
        exclude: ['**/target/**', '**/build/**', '**/*Test.java'],
      };
    }
    case 'cpp': {
      return {
        name: 'cpp-source',
        description: 'C/C++ source code',
        languages: ['cpp'],
        include: ['src/**/*.{c,cpp,cc,h,hpp}', '**/*.{c,cpp,cc,h,hpp}'],
        exclude: ['**/build/**', '**/cmake-build-*/**'],
      };
    }
  }
}

/**
 * Target templates for the given languages, in the order supplied.
 * Callers that need host-canonical order should pass
 * {@link canonicalStarterLanguages} first (or use {@link buildStarterDocumentHeaderInput}).
 */
export function starterTargetTemplates(
  languages: readonly SupportedLanguage[],
): readonly TargetTemplateInput[] {
  return languages.map(starterTargetTemplate);
}

/**
 * Host-owned document header input: schema version, the eleven starter
 * global excludes, and canonical-order target templates.
 */
export function buildStarterDocumentHeaderInput(
  languages: readonly SupportedLanguage[],
): DocumentHeaderInput {
  const ordered = canonicalStarterLanguages(languages);
  return {
    schemaVersion: CLI_SUPPORTED_SCHEMA_VERSION,
    globalExcludes: [...STARTER_GLOBAL_EXCLUDES],
    targets: starterTargetTemplates(ordered),
  };
}

function targetEntry(template: TargetTemplateInput): Record<string, unknown> {
  return {
    description: template.description,
    languages: [...template.languages],
    concerns: [...(template.concerns ?? ['backend'])],
    include: [...template.include],
    exclude: [...template.exclude],
  };
}

/**
 * Host-owned in-memory config document projection (schemaVersion +
 * globalExcludes + targets). Never written to disk by no-init; Init renders
 * the same semantics as YAML via {@link buildStarterDocumentHeaderInput}.
 *
 * Tool namespaces are intentionally absent — they remain Tool-owned and are
 * either resolved from schema defaults (no-init) or appended as scaffold
 * blocks (Init).
 */
export function buildStarterConfigDocument(
  languages: readonly SupportedLanguage[],
): Record<string, unknown> {
  const header = buildStarterDocumentHeaderInput(languages);
  const targets = Object.fromEntries(
    header.targets.map((template) => [template.name, targetEntry(template)]),
  );
  return {
    schemaVersion: header.schemaVersion,
    globalExcludes: [...(header.globalExcludes ?? STARTER_GLOBAL_EXCLUDES)],
    targets,
  };
}
