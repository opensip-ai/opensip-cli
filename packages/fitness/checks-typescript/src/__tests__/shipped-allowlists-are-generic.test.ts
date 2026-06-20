/**
 * @fileoverview De-leak guard (b): the hardcoded allowlists shipped inside the
 * generic @opensip-cli/checks-* packs must contain only language/library-generic
 * entries — never project-specific symbols carried over from the private
 * codebase this tool was extracted from. A leaked safe-symbol silently
 * suppresses real findings in any adopter that happens to use that name.
 *
 * Companion to the source-text guard (a) in
 * opensip-cli/fit/checks/shipped-checks-must-be-generic.mjs. This one inspects
 * the live exported data structures, so it catches a leak the moment it is added
 * to an array — independent of the dogfood run.
 */
import { describe, expect, it } from 'vitest';

import { DOMAIN_SPECIFIC_FUNCTION_NAMES } from '../checks/quality/code-structure/duplicate-utility-functions.js';
import {
  SAFE_BUILDER_PREFIXES,
  SAFE_METHOD_PREFIXES,
} from '../checks/quality/data-integrity/null-safety.js';
import { THROW_ALLOWED_PATHS } from '../checks/quality/patterns/result-pattern-consistency.js';

/**
 * Distinctive project-specific identifiers / brand tokens from the original
 * (pre-open-source) private codebase. None may appear in ANY shipped allowlist;
 * adopters supply their own via recipe config (`additionalSafeBuilders`, etc.).
 *
 * Deliberately limited to UNAMBIGUOUS identifiers: generic-sounding names that
 * legitimately appear in some allowlists (`getConfig`, `getLogger` are valid
 * duplicate-name exemptions in DOMAIN_SPECIFIC_FUNCTION_NAMES) are NOT listed, so
 * this stays false-positive-free.
 */
const FOREIGN_ALLOWLIST_TOKEN =
  /Escrow|I18nError|getSqlite|getDatabase|getRegistry|getSync|getTenantId|TypedEventBus|CredentialConfig|ContextManager|stripThinkTags|getNumberFormatter|getDateFormatter|formatRelative|ensureError|extractErrorMessage|chronoswap|sanitizeForPrompt/i;

/**
 * The only bare (non-member, non-call) identifiers allowed in
 * SAFE_BUILDER_PREFIXES: documented library entry points. Every other entry
 * must be member-qualified (`Object.`, `db.`) or a constructor/call (`new URL(`,
 * `prepare(`). A bare camelCase identifier is almost always a project-specific
 * getter and belongs in recipe config, not the shipped pack.
 */
const REVIEWED_BARE_LIBRARY_BUILDERS = new Set(['createQueryBuilder', 'getRepository']); // TypeORM

function asStrings(entries: Iterable<string | RegExp>): string[] {
  return [...entries].map((e) => (e instanceof RegExp ? e.source : e));
}

describe('shipped allowlists are generic (de-leak guard b)', () => {
  // Count gate: any add/remove to the shipped safe-builder allowlist trips this,
  // forcing the author to bump the count AND have a reviewer confirm the new
  // entry is genuinely generic (not a project-specific symbol that belongs in
  // an adopter's `additionalSafeBuilders` recipe config).
  it('SAFE_BUILDER_PREFIXES holds exactly the reviewed number of generic entries', () => {
    expect(SAFE_BUILDER_PREFIXES).toHaveLength(54);
  });

  it('every SAFE_BUILDER_PREFIXES entry is a language/library construct, not a bare project getter', () => {
    const bareLeaks = SAFE_BUILDER_PREFIXES.filter(
      (e) => !e.includes('.') && !e.includes('(') && !REVIEWED_BARE_LIBRARY_BUILDERS.has(e),
    );
    expect(bareLeaks).toEqual([]);
  });

  it('no shipped allowlist contains a foreign project-specific identifier', () => {
    const arrays: Record<string, string[]> = {
      SAFE_BUILDER_PREFIXES: asStrings(SAFE_BUILDER_PREFIXES),
      SAFE_METHOD_PREFIXES: asStrings(SAFE_METHOD_PREFIXES),
      THROW_ALLOWED_PATHS: asStrings(THROW_ALLOWED_PATHS),
      DOMAIN_SPECIFIC_FUNCTION_NAMES: asStrings(DOMAIN_SPECIFIC_FUNCTION_NAMES),
    };
    for (const [name, entries] of Object.entries(arrays)) {
      const leaked = entries.filter((e) => FOREIGN_ALLOWLIST_TOKEN.test(e));
      expect(leaked, `${name} must not contain foreign-domain symbols`).toEqual([]);
    }
  });
});
