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

import {
  buildStarterConfigDocument,
  canonicalStarterLanguages,
  STARTER_GLOBAL_EXCLUDES,
} from './starter-config.js';

export interface NoInitConfigSynthesis {
  readonly document: Record<string, unknown>;
  readonly languages: readonly SupportedLanguage[];
}

/**
 * @deprecated Prefer {@link STARTER_GLOBAL_EXCLUDES}. Kept as a stable alias so
 * existing call sites and tests that named the no-init list keep resolving.
 */
export const NO_INIT_GLOBAL_EXCLUDES: readonly string[] = STARTER_GLOBAL_EXCLUDES;

export function synthesizeNoInitConfigDocument(cwd: string): NoInitConfigSynthesis | undefined {
  const languages = canonicalStarterLanguages(detectLanguages(cwd));
  if (languages.length === 0) return undefined;

  return {
    languages,
    document: buildStarterConfigDocument(languages),
  };
}
