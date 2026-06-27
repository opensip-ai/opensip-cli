/**
 * @fileoverview Directive Inventory - shared parsing logic for
 * fitness-ignore directives.
 */

import { stripCommentOpener } from './comment-openers.js';

// =============================================================================
// Types
// =============================================================================

/** A single fitness-ignore directive found in a source file. */
export interface DirectiveEntry {
  filePath: string;
  lineNumber: number;
  type: 'file' | 'next-line';
  checkId: string;
  group: string;
  reason: string | null;
  weakReason: boolean;
}

// =============================================================================
// Shared Constants
// =============================================================================

/** Patterns that indicate a weak or generic ignore reason. */
const WEAK_REASON_PATTERNS = Object.freeze<readonly RegExp[]>([
  /^ignore$/i,
  /^skip$/i,
  /^todo$/i,
  /^fixme$/i,
  /^temporary$/i,
  /^temp$/i,
  /^wip$/i,
  /^disable$/i,
  /^suppress$/i,
  /^\s*$/,
]);

// =============================================================================
// Shared Parsing
// =============================================================================

/**
 * Parse a file-level or next-line directive from a comment line.
 *
 * Accepts every comment opener the suppression parser supports
 * (`//`, `/*`, `<!--`, `#`) — sourced from the shared COMMENT_OPENERS
 * table so the inventory and the suppressor stay in sync. Previously
 * the inventory only recognized `// ` and `/* `, so block-comment
 * directives suppressed findings but vanished from inventory counts.
 */
export function parseDirectiveLine(line: string): {
  type: 'file' | 'next-line';
  checkId: string;
  reason: string | null;
} | null {
  const trimmed = line.trimStart();
  const stripped = stripCommentOpener(trimmed);
  if (stripped === null) return null;

  const afterComment = stripped.trimStart();

  if (afterComment.startsWith('@fitness-ignore-file ')) {
    const rest = afterComment.slice('@fitness-ignore-file '.length);
    return parseDirectiveRest(rest, 'file');
  }

  if (afterComment.startsWith('@fitness-ignore-next-line ')) {
    const rest = afterComment.slice('@fitness-ignore-next-line '.length);
    return parseDirectiveRest(rest, 'next-line');
  }

  return null;
}

function parseDirectiveRest(
  rest: string,
  type: 'file' | 'next-line',
): {
  type: 'file' | 'next-line';
  checkId: string;
  reason: string | null;
} | null {
  // Strip trailing block-comment terminators: `*/` (C-family) and `-->` (HTML).
  // eslint-disable-next-line sonarjs/slow-regex -- anchored at end-of-string, bounded \s* runs; no ReDoS exposure
  const normalized = rest.replace(/\s*(?:\*\/|-->)\s*$/, '').trimEnd();

  const separatorIndex = normalized.indexOf(' -- ');

  if (separatorIndex === -1) {
    const checkId = normalized.trim();
    if (!checkId || checkId.includes(' ')) return null;
    return { type, checkId, reason: null };
  }

  const checkId = normalized.slice(0, separatorIndex).trim();
  const reason = normalized.slice(separatorIndex + 4).trim();

  if (!checkId || checkId.includes(' ')) return null;
  return { type, checkId, reason: reason || null };
}

/**
 * Check if a reason is weak/generic. Missing reason (null) is considered weak.
 */
export function isWeakReason(reason: string | null): boolean {
  if (reason === null) return true;
  return WEAK_REASON_PATTERNS.some((pattern) => pattern.test(reason.trim()));
}

/**
 * Extract the group prefix from a check ID (the directory name).
 */
export function extractGroup(checkId: string): string {
  const slashIndex = checkId.indexOf('/');
  return slashIndex > 0 ? checkId.slice(0, slashIndex) : 'other';
}
