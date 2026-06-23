/**
 * ToolIdentity — author-facing tool naming (ADR tool-identity-single-source).
 *
 * One declaration from which the host derives CLI verbs, config namespace,
 * plugin layout domain, session discriminant, and manifest human key.
 */

import { ValidationError } from '../lib/errors.js';

/** Author-facing tool naming — one declaration, host-derived everywhere else. */
export interface ToolIdentity {
  /**
   * Canonical name: CLI primary verb, config namespace, registry key,
   * manifest human id, host-dispatched live-view key, nested-command parent.
   */
  readonly name: string;

  /**
   * Optional CLI aliases (shortenings only). Host injects onto the primary
   * CommandSpec at normalize time.
   */
  readonly aliases?: readonly string[];

  /**
   * Short runtime discriminant for plugins.* config keys, on-disk layout,
   * session.tool column, and SignalEnvelope.tool when tools stamp layout key.
   * Defaults to `name` when omitted.
   */
  readonly layoutKey?: string;
}

const IDENTITY_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function validateIdentityName(value: string, field: 'name' | 'layoutKey'): void {
  if (value.trim() === '' || !IDENTITY_NAME_PATTERN.test(value)) {
    throw new ValidationError(
      `Tool identity ${field} '${value}' must be a non-empty kebab-case or single lowercase word.`,
      { code: 'TOOL.IDENTITY.INVALID_NAME' },
    );
  }
}

/** Validate and normalize a {@link ToolIdentity} at defineTool time. */
export function validateToolIdentity(identity: ToolIdentity): {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly layoutKey: string;
} {
  if (identity === undefined || identity === null || typeof identity !== 'object') {
    throw new ValidationError('Tool identity is required.', { code: 'TOOL.IDENTITY.REQUIRED' });
  }

  const name = identity.name;
  if (typeof name !== 'string') {
    throw new ValidationError('Tool identity is required.', { code: 'TOOL.IDENTITY.REQUIRED' });
  }
  validateIdentityName(name, 'name');

  const aliases = identity.aliases ?? [];
  if (!Array.isArray(aliases)) {
    throw new ValidationError('Tool identity aliases must be an array.', {
      code: 'TOOL.IDENTITY.DUPLICATE_ALIAS',
    });
  }

  const seenAliases = new Set<string>();
  for (const alias of aliases) {
    if (typeof alias !== 'string' || alias.trim() === '') {
      throw new ValidationError('Tool identity aliases must be non-empty strings.', {
        code: 'TOOL.IDENTITY.DUPLICATE_ALIAS',
      });
    }
    validateIdentityName(alias, 'name');
    if (alias === name) {
      throw new ValidationError(`Tool identity name '${name}' must not appear in aliases.`, {
        code: 'TOOL.IDENTITY.NAME_IN_ALIASES',
      });
    }
    if (seenAliases.has(alias)) {
      throw new ValidationError(`Duplicate tool identity alias '${alias}'.`, {
        code: 'TOOL.IDENTITY.DUPLICATE_ALIAS',
      });
    }
    seenAliases.add(alias);
  }

  const layoutKey = identity.layoutKey ?? name;
  if (typeof layoutKey !== 'string') {
    throw new ValidationError('Tool identity layoutKey must be a string.', {
      code: 'TOOL.IDENTITY.INVALID_NAME',
    });
  }
  validateIdentityName(layoutKey, 'layoutKey');

  return { name, aliases, layoutKey };
}
