/**
 * @fileoverview Error code registration check
 */

import {
  defineCheck,
  isTestFile,
  type CheckViolation,
  type FileAccessor,
} from '@opensip-cli/fitness';

import { createCodeMask, findStaticStringLiterals } from '../code-aware-match.js';

const REGISTERED_CODE_LITERAL_REGEX = /(['"])([A-Z][A-Z0-9]*(?:\.[A-Z][A-Z0-9_]*){2,})\1/g;
const ERROR_CODE_VALUE_REGEX = /^[A-Z][A-Z0-9]*(?:\.[A-Z][A-Z0-9_]*){2,}$/;

function previousTokenIndex(codeMask: string, fromIndex: number): number {
  let index = fromIndex;
  while (index >= 0 && /\s/.test(codeMask[index] ?? '')) index--;
  return index;
}

function containsOnlyTrivia(content: string, start: number, end: number): boolean {
  let index = start;
  while (index < end) {
    if (/\s/.test(content[index] ?? '')) {
      index++;
      continue;
    }
    if (content.startsWith('//', index)) {
      const newline = content.indexOf('\n', index + 2);
      index = newline === -1 ? end : newline + 1;
      continue;
    }
    if (content.startsWith('/*', index)) {
      const closing = content.indexOf('*/', index + 2);
      if (closing === -1 || closing + 2 > end) return false;
      index = closing + 2;
      continue;
    }
    return false;
  }
  return true;
}

function quotedPropertyName(
  content: string,
  codeMask: string,
  closingQuote: number,
): string | null {
  const quote = codeMask[closingQuote];
  if (quote !== '"' && quote !== "'") return null;
  const openingQuote = codeMask.lastIndexOf(quote, closingQuote - 1);
  return openingQuote === -1 ? null : content.slice(openingQuote + 1, closingQuote);
}

function computedPropertyName(
  content: string,
  codeMask: string,
  closingBracket: number,
): string | null {
  const openingBracket = codeMask.lastIndexOf('[', closingBracket - 1);
  if (openingBracket === -1) return null;
  const rawName = content.slice(openingBracket + 1, closingBracket).trim();
  const match = /^(['"])(code|errorCode)\1$/.exec(rawName);
  return match?.[2] ?? null;
}

function propertyNameBeforeLiteral(
  content: string,
  codeMask: string,
  literalStart: number,
): string | null {
  const colon = previousTokenIndex(codeMask, literalStart - 1);
  if (codeMask[colon] !== ':') return null;
  if (!containsOnlyTrivia(content, colon + 1, literalStart)) return null;
  const end = previousTokenIndex(codeMask, colon - 1);
  if (end < 0) return null;

  if (codeMask[end] === ']') return computedPropertyName(content, codeMask, end);
  if (codeMask[end] === '"' || codeMask[end] === "'") {
    return quotedPropertyName(content, codeMask, end);
  }

  let start = end;
  while (start >= 0 && /[\w$]/.test(codeMask[start] ?? '')) start--;
  return codeMask.slice(start + 1, end + 1);
}

interface ErrorCodeUsage {
  readonly code: string;
  readonly index: number;
}

function errorCodeUsages(
  filePath: string,
  content: string,
  codeMask: string,
): readonly ErrorCodeUsage[] {
  const structuralLiterals = findStaticStringLiterals(filePath, content);
  if (structuralLiterals.length > 0) {
    return structuralLiterals.flatMap((literal) =>
      literal.role === 'object-property' &&
      (literal.propertyName === 'code' || literal.propertyName === 'errorCode') &&
      ERROR_CODE_VALUE_REGEX.test(literal.value)
        ? [{ code: literal.value, index: literal.start }]
        : [],
    );
  }

  return [...content.matchAll(REGISTERED_CODE_LITERAL_REGEX)].flatMap((match) => {
    if (
      match.index === undefined ||
      !match[2] ||
      !['code', 'errorCode'].includes(
        propertyNameBeforeLiteral(content, codeMask, match.index) ?? '',
      )
    ) {
      return [];
    }
    return [{ code: match[2], index: match.index }];
  });
}

function registeredErrorCodes(
  filePath: string,
  content: string,
  codeMask: string,
): readonly string[] {
  const structuralLiterals = findStaticStringLiterals(filePath, content);
  if (structuralLiterals.length > 0) {
    return structuralLiterals.flatMap((literal) =>
      literal.role !== 'other' && ERROR_CODE_VALUE_REGEX.test(literal.value) ? [literal.value] : [],
    );
  }

  return [...content.matchAll(REGISTERED_CODE_LITERAL_REGEX)].flatMap((match) => {
    if (match.index === undefined || !match[2]) return [];
    const anchor = previousTokenIndex(codeMask, match.index - 1);
    if (
      !['=', ':', '[', ','].includes(codeMask[anchor] ?? '') ||
      !containsOnlyTrivia(content, anchor + 1, match.index)
    ) {
      return [];
    }
    return [match[2]];
  });
}

/** Registries recognised by filename, for projects whose codes live in a constant table. */
const REGISTRY_FILE_PATTERN = /(?:error-codes|error-registry|errors|error-catalog)\.ts$/;

/**
 * Registries recognised by content — the general rule.
 *
 * Any call to a `define*Catalog` / `create*Registry`-shaped builder marks the file as the place
 * codes are declared, regardless of what it is named. Deliberately shape-based rather than
 * naming one framework's function: this check ships to consumers whose registry helper we
 * cannot know.
 */
const CATALOG_DECLARATION_PATTERN =
  /\b(?:define|create|build)[A-Za-z]*(?:ErrorCatalog|ErrorRegistry|ErrorCodes)\s*[(<]/u;

/**
 * Registries recognised by SHAPE — the rule that catches a registry split across modules.
 *
 * A catalog large enough to be worth having usually outgrows one file: the builder call sits in
 * an assembling module while the definitions live in siblings that merely export objects. Those
 * siblings match neither the name nor the builder-call rule, so their codes read as unregistered
 * everywhere they are used.
 *
 * What they do have is a declaration shape: the same literal appears as a property KEY and again
 * as that entry's `code` value. A file that USES a code never does both. This is deliberately a
 * statement about shape rather than about any one framework.
 */
/** Escape a literal string for safe interpolation into a `RegExp` source. */
function escapeRegExpLiteral(literal: string): string {
  return literal.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function declaresErrorCodes(content: string): boolean {
  for (const match of content.matchAll(/['"]([A-Z][A-Z0-9_]*(?:\.[A-Z][A-Z0-9_]*)+)['"]\s*:/gu)) {
    const code = match[1];
    if (
      code !== undefined &&
      new RegExp(`\\bcode:\\s*['"]${escapeRegExpLiteral(code)}['"]`, 'u').test(content)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Check: resilience/error-code-registration
 *
 * Validates that error codes used in code are registered in
 * an error registry file (error-codes.ts, errors.ts, etc.)
 */
export const errorCodeRegistration = defineCheck({
  id: '346b53d8-58a3-4fd5-8340-d7bd42da406a',
  slug: 'error-code-registration',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Validates that error codes used in code are registered in an error registry file',
  longDescription: `**Purpose:** Ensures all error codes used in the codebase are registered in a central error registry file, enabling error catalogs, monitoring, and consistent conventions.

**Detects:**
- Error codes (DOMAIN.CATEGORY.SPECIFIC format) used in \`code:\` or \`errorCode:\` properties that are not defined in any error-codes.ts, errors.ts, or error-registry.ts file

**Why it matters:** Unregistered error codes make centralized error catalogs incomplete, complicate monitoring, and lead to ad-hoc codes that don't follow conventions.

**Scope:** Backend code. Analyzes all matched files together (\`analyzeAll\`) to correlate error code usage with registry definitions.`,
  tags: ['errors', 'resilience', 'consistency'],
  fileTypes: ['ts'],

  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const violations: CheckViolation[] = [];

    // Phase 1: Collect all registered error codes from registry files.
    //
    // Registration is recognised by NAME or by CONTENT. Name alone was not enough: a project
    // that registers through a catalog builder puts its codes in files this pattern never
    // matched, so every registered code read as unregistered — the check reported a wall of
    // false positives on a correctly-registered codebase, which is why it shipped disabled.
    // Content detection is the general rule; the name patterns stay for projects whose registry
    // is a plain constant table.
    const registeredCodes = new Set<string>();

    const allContents = await files.readMany(files.paths);
    const isRegistry = (fp: string): boolean =>
      REGISTRY_FILE_PATTERN.test(fp) ||
      CATALOG_DECLARATION_PATTERN.test(allContents.get(fp) ?? '') ||
      declaresErrorCodes(allContents.get(fp) ?? '');

    const registryPaths = files.paths.filter((fp) => isRegistry(fp));

    for (const filePath of registryPaths) {
      const content = allContents.get(filePath);
      if (!content) continue;

      // Registry files define their catalog through literal values in
      // assignments, object properties, or arrays. Match the literal token
      // itself so legal comments and quoted property keys cannot break the
      // association, while the code mask excludes examples in comments.
      const codeMask = createCodeMask(filePath, content);
      for (const code of registeredErrorCodes(filePath, content, codeMask))
        registeredCodes.add(code);
    }

    // Phase 2: Scan non-registry PRODUCTION files for error code usage.
    //
    // Tests are skipped deliberately. A test that proves an unrecognised failure PROPAGATES has
    // to construct one, and the code it invents is arbitrary by design — that is the point of
    // the fixture. Demanding those be registered would force meaningless entries into the
    // catalog and make the check unusable on any codebase that tests its error handling.
    for (const filePath of files.paths) {
      if (!filePath || isRegistry(filePath) || isTestFile(filePath)) continue;
      const content = allContents.get(filePath);
      if (!content) continue;
      const lines = content.split('\n');
      const codeMask = createCodeMask(filePath, content);

      for (const usage of errorCodeUsages(filePath, content, codeMask)) {
        if (registeredCodes.has(usage.code)) continue;
        const line = content.slice(0, usage.index).split('\n').length;
        violations.push({
          filePath,
          line,
          message: `Error code '${usage.code}' is used but not registered in any error registry file`,
          severity: 'warning',
          suggestion: `Add '${usage.code}' to your error registry — a catalog builder (e.g. defineErrorCatalog) or an error-codes.ts / error-registry.ts table`,
          type: 'unregistered-error-code',
          match: (lines[line - 1] ?? usage.code).trim().slice(0, 120),
        });
      }
    }

    return violations;
  },
});
