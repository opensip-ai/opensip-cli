/**
 * no-init-config — deterministic in-memory config synthesis for first runs.
 *
 * The synthesized document is never written to disk. It is passed through the
 * same composed config validation path as `opensip-cli.config.yml`. Host-owned
 * starter semantics (languages, excludes, targets) come from
 * {@link ./starter-config.ts}; this module only detects languages and
 * packages the result.
 */

import { detectLanguages, type SupportedLanguage } from '../commands/init/language-detection.js';

import { buildStarterConfigDocument, canonicalStarterLanguages } from './starter-config.js';

export interface NoInitConfigSynthesis {
  readonly document: Record<string, unknown>;
  readonly languages: readonly SupportedLanguage[];
}

export function synthesizeNoInitConfigDocument(cwd: string): NoInitConfigSynthesis | undefined {
  const languages = canonicalStarterLanguages(detectLanguages(cwd));
  if (languages.length === 0) return undefined;

  return {
    languages,
    document: buildStarterConfigDocument(languages),
  };
}
