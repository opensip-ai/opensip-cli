/**
 * Host-owned document skeleton for the `opensip init` config.
 *
 * Owns ONLY the document-level bytes: the YAML header, `schemaVersion`,
 * `globalExcludes`, and the per-language `targets:` blocks. Each tool's
 * own config block (e.g. `fitness:`) is contributed by the tool via
 * `Tool.scaffoldConfigBlock()` (ADR-0038 Decision 2) and appended here —
 * the host never hard-codes a tool's namespace. The example check / recipe
 * / scenario `.mjs` bytes and the pinned check-id universe likewise live in
 * the owning tool's `scaffold/` (relocated out of this file in ADR-0038
 * Phases 1–2).
 */

import { renderDocumentHeader, type TargetTemplateInput } from '@opensip-cli/config';
import { CLI_SUPPORTED_SCHEMA_VERSION } from '@opensip-cli/core';

import type { SupportedLanguage } from './language-detection.js';
import type { ToolScaffold } from '../shared.js';

type TargetTemplate = TargetTemplateInput;

function targetTemplate(lang: SupportedLanguage): TargetTemplate {
  switch (lang) {
    case 'typescript': {
      return {
        name: 'typescript-source',
        description: 'TypeScript / TSX source code',
        languages: ['typescript'],
        include: [
          'src/**/*.ts',
          'src/**/*.tsx',
          'packages/*/src/**/*.ts',
          'packages/*/src/**/*.tsx',
        ],
        exclude: [
          '**/*.test.ts',
          '**/*.test.tsx',
          '**/__tests__/**',
          '**/node_modules/**',
          '**/dist/**',
        ],
      };
    }
    case 'rust': {
      return {
        name: 'rust-source',
        description: 'Rust source code',
        languages: ['rust'],
        include: ['src/**/*.rs', 'crates/**/*.rs', 'services/**/*.rs'],
        exclude: ['**/target/**'],
      };
    }
    case 'python': {
      return {
        name: 'python-source',
        description: 'Python source code',
        languages: ['python'],
        include: ['src/**/*.py', '**/*.py'],
        exclude: [
          '**/__pycache__/**',
          '**/.venv/**',
          '**/venv/**',
          '**/dist/**',
          '**/build/**',
          '**/*.egg-info/**',
        ],
      };
    }
    case 'go': {
      return {
        name: 'go-source',
        description: 'Go source code',
        languages: ['go'],
        include: ['**/*.go'],
        exclude: ['**/vendor/**', '**/_test.go'],
      };
    }
    case 'java': {
      return {
        name: 'java-source',
        description: 'Java source code',
        languages: ['java'],
        include: ['src/main/java/**/*.java', 'src/**/*.java'],
        exclude: ['**/target/**', '**/build/**', '**/*Test.java'],
      };
    }
    case 'cpp': {
      return {
        name: 'cpp-source',
        description: 'C/C++ source code',
        languages: ['cpp'],
        include: ['src/**/*.{c,cpp,cc,h,hpp}', '**/*.{c,cpp,cc,h,hpp}'],
        exclude: ['**/build/**', '**/cmake-build-*/**'],
      };
    }
  }
}

export function generateConfig(
  languages: readonly SupportedLanguage[],
  toolScaffolds: readonly ToolScaffold[],
): string {
  // The document-level skeleton (header, schemaVersion, globalExcludes, targets)
  // is rendered by @opensip-cli/config — the package that also OWNS + validates
  // those blocks (2.10.1, ADR-0023), so the scaffold cannot drift from what the
  // composed schema accepts (asserted by a round-trip test). The CLI supplies the
  // per-language target content; each registered tool contributes its own config
  // block (ADR-0038 Decision 2 — fitness owns `fitness:`, sim contributes none).
  const header = renderDocumentHeader({
    schemaVersion: CLI_SUPPORTED_SCHEMA_VERSION,
    targets: languages.map(targetTemplate),
  });

  const toolBlocks = toolScaffolds
    .map((ts) => ts.scaffoldConfigBlock?.())
    .filter((block): block is string => block !== undefined)
    .join('');

  return `${header}\n${toolBlocks}`;
}
