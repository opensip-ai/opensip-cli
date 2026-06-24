/**
 * hashFunctionBody — content-keyed identity for a function declaration.
 *
 * Used by stage 1 (catalog construction) and stage 2
 * (find-catalog-entry) and cache invalidation. Per spec §2.2 / DRY-2:
 * "same body in two files → same hash; body changed by one character →
 * new hash."
 */

import { digestCanonicalBody } from '@opensip-cli/graph';
import { stripComments } from '@opensip-cli/lang-typescript';

import type ts from 'typescript';

/**
 * Result of normalizing + hashing a function body. `size` is the
 * length of the normalized text in characters; rules use it to skip
 * trivial wrappers whose duplication is structural, not actionable.
 */
export interface BodyDigest {
  readonly hash: string;
  readonly size: number;
  readonly signature?: readonly number[];
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
 *
 * Uses `sourceFile.text.slice(...)` instead of `node.getText(sourceFile)`
 * to avoid the per-call AST walk that materializes a fresh string.
 * V8 implements substring as a slice into the parent string when the
 * source buffer is large, so this is also lower-allocation. The two
 * paths produce identical content for the same node (both span from
 * `getStart()` to `getEnd()`).
 */
export function digestFunctionBody(node: ts.Node, sourceFile: ts.SourceFile): BodyDigest {
  const text = sourceFile.text.slice(node.getStart(sourceFile), node.getEnd());
  const normalized = normalizeWhitespace(stripComments(text));
  return digestCanonicalBody(normalized);
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
  return digestCanonicalBody(normalized);
}

function normalizeWhitespace(s: string): string {
  return s.replaceAll(/\s+/g, ' ').trim();
}
