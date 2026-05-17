/**
 * hashFunctionBody — content-keyed identity for a function declaration.
 *
 * Used by stage 1 (catalog construction) and stage 2
 * (find-catalog-entry) and cache invalidation. Per spec §2.2 / DRY-2:
 * "same body in two files → same hash; body changed by one character →
 * new hash."
 */

import { createHash } from 'node:crypto';

import { stripComments } from '@opensip-tools/lang-typescript';

import type ts from 'typescript';

/**
 * Result of normalizing + hashing a function body. `size` is the
 * length of the normalized text in characters; rules use it to skip
 * trivial wrappers whose duplication is structural, not actionable.
 */
export interface BodyDigest {
  readonly hash: string;
  readonly size: number;
}

/**
 * Compute the bodyHash for a function-shaped node (declaration,
 * expression, arrow, method, etc.). The text is normalized — comments
 * stripped, whitespace collapsed — so cosmetic edits don't churn the
 * hash.
 */
export function hashFunctionBody(node: ts.Node, sourceFile: ts.SourceFile): string {
  return digestFunctionBody(node, sourceFile).hash;
}

/**
 * Like `hashFunctionBody`, but also returns the normalized size.
 */
export function digestFunctionBody(node: ts.Node, sourceFile: ts.SourceFile): BodyDigest {
  const text = node.getText(sourceFile);
  const normalized = normalizeWhitespace(stripComments(text));
  return { hash: sha256(normalized), size: normalized.length };
}

/**
 * Hash a synthetic body string (used by module-init.ts which
 * synthesizes a body from top-level statements).
 */
export function hashSyntheticBody(input: string): string {
  return digestSyntheticBody(input).hash;
}

export function digestSyntheticBody(input: string): BodyDigest {
  const normalized = normalizeWhitespace(stripComments(input));
  return { hash: sha256(normalized), size: normalized.length };
}

function normalizeWhitespace(s: string): string {
  return s.replaceAll(/\s+/g, ' ').trim();
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
