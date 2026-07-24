/**
 * @fileoverview Directive Inventory - shared parsing logic for
 * fitness-ignore directives.
 */

import { commentTextAfterOpener } from './comment-openers.js';

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
 * Must recognize exactly what the suppression matcher honours, or a directive
 * suppresses findings while vanishing from the `appliedDirectives` audit.
 * That means: the same string-aware anywhere-in-line comment scan the
 * suppressor uses (`commentTextAfterOpener` — trailing comments after code
 * count), and the same keyword separator rule (space OR tab).
 */
export function parseDirectiveLine(line: string): {
  type: 'file' | 'next-line';
  checkId: string;
  reason: string | null;
} | null {
  const commentText = commentTextAfterOpener(line);
  if (commentText === null) return null;

  const afterComment = commentText.trimStart();

  for (const [keyword, type] of [
    ['@fitness-ignore-file', 'file'],
    ['@fitness-ignore-next-line', 'next-line'],
  ] as const) {
    if (!afterComment.startsWith(keyword)) continue;
    const separator = afterComment[keyword.length];
    // Mirror the suppressor's separator rule: space or tab after the keyword.
    if (separator !== ' ' && separator !== '\t') return null;
    return parseDirectiveRest(afterComment.slice(keyword.length + 1), type);
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

  const normalized = rest.replace(/\s*(?:\*\/|-->)\s*$/, '').trimEnd();

  const separatorIndex = normalized.indexOf(' -- ');

  if (separatorIndex === -1) {
    const checkId = normalized.trim();
    if (!checkId || /\s/.test(checkId)) return null;
    return { type, checkId, reason: null };
  }

  const checkId = normalized.slice(0, separatorIndex).trim();
  const reason = normalized.slice(separatorIndex + 4).trim();

  if (!checkId || /\s/.test(checkId)) return null;
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
