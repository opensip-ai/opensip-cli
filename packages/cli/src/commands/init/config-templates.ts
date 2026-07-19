/**
 * Host-owned document skeleton for the `opensip init` config.
 *
 * Owns ONLY the document-level YAML rendering: the header, `schemaVersion`,
 * `globalExcludes`, and the per-language `targets:` blocks. Starter content
 * (excludes, target templates, language order) comes from the shared
 * host model in `bootstrap/starter-config.ts` so Init matches no-init
 * analysis semantics. Each tool's own config block (e.g. `fitness:`) is
 * contributed by the tool via `Tool.scaffoldConfigBlock()` (ADR-0038
 * Decision 2) and appended here — the host never hard-codes a tool's
 * namespace. The example check / recipe / scenario `.mjs` bytes and the
 * pinned check-id universe likewise live in the owning tool's `scaffold/`.
 */

import { renderDocumentHeader } from '@opensip-cli/config';

import { buildStarterDocumentHeaderInput } from '../../bootstrap/starter-config.js';

import type { SupportedLanguage } from './language-detection.js';
import type { RenderedToolScaffold, ToolScaffold } from '../shared.js';

export function generateConfig(
  languages: readonly SupportedLanguage[],
  toolScaffolds: readonly ToolScaffold[],
): string {
  const toolBlocks = toolScaffolds
    .map((toolScaffold) => toolScaffold.scaffoldConfigBlock?.())
    .filter((block): block is string => block !== undefined);
  return generateConfigFromBlocks(languages, toolBlocks);
}

/**
 * Render config bytes from a callback-free Tool scaffold snapshot.
 *
 * The future authored-plan builder evaluates every Tool hook once up front and
 * feeds the resulting snapshot here. The existing `generateConfig` wrapper
 * remains available while Init still accepts live contributions.
 */
export function generateConfigFromRenderedScaffolds(
  languages: readonly SupportedLanguage[],
  toolScaffolds: readonly RenderedToolScaffold[],
): string {
  return generateConfigFromBlocks(
    languages,
    toolScaffolds
      .map((toolScaffold) => toolScaffold.configBlock)
      .filter((block): block is string => block !== undefined),
  );
}

function generateConfigFromBlocks(
  languages: readonly SupportedLanguage[],
  toolBlocks: readonly string[],
): string {
  // Shared starter header (schemaVersion, eleven excludes, canonical targets)
  // is rendered by @opensip-cli/config from the host-owned DocumentHeaderInput.
  // Each registered tool contributes its own config block (ADR-0038 Decision 2).
  const header = renderDocumentHeader(buildStarterDocumentHeaderInput(languages));

  return `${header}\n${toolBlocks.join('')}`;
}
