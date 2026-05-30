/**
 * @fileoverview Shared body-digest primitives for GraphLanguageAdapters.
 *
 * The catalog's `bodyHash` contract is "reduce a function body to a
 * canonical string, then SHA-256 it." The normalize-to-hash TAIL of that
 * pipeline — the `BodyDigest` shape, the whitespace-collapse normalizer,
 * and the hash+size step — was byte-identical across every adapter that
 * hashes bodies (go/java/rust real bodies, plus the synthetic-body path
 * in all four tree-sitter packs). Per the round-3 modular-monolith audit
 * (2026-05-30, finding D) it lives here on the contract layer instead of
 * being copy-pasted into each pack.
 *
 * This mirrors edge-helpers.ts exactly: tiny utilities that used to be
 * duplicated under each adapter now sit in lang-adapter/, which adapters
 * already import types from — so importing one more helper is
 * structurally consistent and violates no layering rule (lang-* adapters
 * may not import each OTHER, but lang-adapter/ is fair game).
 *
 * What deliberately STAYS in each adapter pack: the language-specific
 * comment stripper (Go rune literals vs Java text blocks vs Rust nested
 * block comments) and any language-specific normalization. Python, for
 * example, substitutes its own `normalizePythonBody` for real bodies
 * because indentation is semantically significant there — it still
 * composes `hashBody` + `normalizeWhitespace` for synthetic bodies. The
 * primitives are intentionally low-level (not a single `digestBody(text,
 * stripFn)`) precisely so a pack can swap the normalization step.
 */

import { createHash } from 'node:crypto';

/** Catalog body fingerprint: SHA-256 hex hash + canonical-text length. */
export interface BodyDigest {
  readonly hash: string;
  readonly size: number;
}

/**
 * Collapse every run of whitespace to a single space and trim. The
 * default body normalization for whitespace-insensitive languages
 * (Go/Java/Rust) and for synthetic (module-init) bodies in every pack.
 */
export function normalizeWhitespace(s: string): string {
  return s.replaceAll(/\s+/g, ' ').trim();
}

/**
 * SHA-256 an already-normalized ("canonical") body string into a
 * `BodyDigest`. `size` is the canonical-text length so it tracks the
 * hashed content, not the raw source. Callers normalize first — via
 * `normalizeWhitespace` or a language-specific normalizer.
 */
export function hashBody(canonical: string): BodyDigest {
  return {
    hash: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    size: canonical.length,
  };
}
