/**
 * @fileoverview Body-digest primitives — relocated to `@opensip-cli/clone-detection`.
 *
 * The hash/normalize tail (`BodyDigest`, `normalizeWhitespace`, `hashBody`) moved to
 * the shared layer-2 substrate (ADR-0064) so both graph and yagni single-source it and
 * cannot diverge. This module re-exports the same symbols verbatim so every existing
 * graph-engine + adapter importer of `'../lang-adapter/body-digest.js'` is unchanged
 * and `bodyHash` values stay byte-identical.
 *
 * Language-specific comment strippers / normalizers still live in each adapter pack;
 * only the canonical-string→hash tail is shared (see the package).
 */

export { normalizeWhitespace, hashBody, type BodyDigest } from '@opensip-cli/clone-detection';
