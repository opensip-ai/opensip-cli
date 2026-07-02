/**
 * no-init-config — deterministic in-memory config synthesis for first runs.
 *
 * The synthesized document is never written to disk. It is passed through the
 * same composed config validation path as `opensip-cli.config.yml`.
 */

import { CLI_SUPPORTED_SCHEMA_VERSION } from '@opensip-cli/core';

import { targetTemplatesForLanguages } from '../commands/init/config-templates.js';
import {
  ALL_LANGUAGES,
  detectLanguages,
  type SupportedLanguage,
} from '../commands/init/language-detection.js';

import type { TargetTemplateInput } from '@opensip-cli/config';

export interface NoInitConfigSynthesis {
  readonly document: Record<string, unknown>;
  readonly languages: readonly SupportedLanguage[];
}

export const NO_INIT_GLOBAL_EXCLUDES: readonly string[] = [
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
];

function canonicalLanguageOrder(
  languages: readonly SupportedLanguage[],
): readonly SupportedLanguage[] {
  const detected = new Set(languages);
  return ALL_LANGUAGES.filter((language) => detected.has(language));
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

export function synthesizeNoInitConfigDocument(cwd: string): NoInitConfigSynthesis | undefined {
  const languages = canonicalLanguageOrder(detectLanguages(cwd));
  if (languages.length === 0) return undefined;

  const targets = Object.fromEntries(
    targetTemplatesForLanguages(languages).map((template) => [
      template.name,
      targetEntry(template),
    ]),
  );

  return {
    languages,
    document: {
      schemaVersion: CLI_SUPPORTED_SCHEMA_VERSION,
      globalExcludes: [...NO_INIT_GLOBAL_EXCLUDES],
      targets,
    },
  };
}
