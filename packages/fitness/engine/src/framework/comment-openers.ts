/**
 * @fileoverview Comment-opener table — re-exported from the kernel.
 *
 * The canonical table now lives in `@opensip-cli/core`
 * (`signals/comment-openers.ts`, ADR-0014) so the suppression scanner and the
 * fitness directive inventory share a single source of truth (they
 * historically drifted). This module preserves the local import path for
 * fitness consumers (`directive-inventory.ts`).
 */

export { COMMENT_OPENERS, stripCommentOpener } from '@opensip-cli/core';
