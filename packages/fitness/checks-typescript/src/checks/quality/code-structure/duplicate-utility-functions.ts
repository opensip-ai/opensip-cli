// @fitness-ignore-file throws-documentation -- Functions throw self-documenting typed errors
// @fitness-ignore-file toctou-race-condition -- TOCTOU acceptable in this non-concurrent context
// @fitness-ignore-file file-length-limit -- complex check with tightly coupled hash/normalization/scoring logic; splitting would risk losing the duplicate-detection contract
/**
 * @fileoverview Duplicate Utility Functions check
 *
 * Detects duplicate utility functions that should be consolidated.
 * Flags TWO types of issues:
 * 1. Identical implementations - true duplicates that must be deduplicated
 * 2. Same-named functions with different implementations - consolidation opportunities
 */

import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';

import {
  defineCheck,
  getCheckConfig,
  type CheckViolation,
  type FileAccessor,
} from '@opensip-tools/fitness';
import { getSharedSourceFile } from '@opensip-tools/lang-typescript';
import * as ts from 'typescript';

/**
 * Recipe-config shape for the duplicate-utility-functions check. Augments
 * the built-in {@link DOMAIN_SPECIFIC_FUNCTIONS} list with project-specific
 * names that are deliberately distinct implementations sharing a name.
 *
 * Project-specific functions like `getCurrentCorrelationId`, `formatDuration`,
 * `getRemoteUrl`, `sanitizeForPrompt`, etc. belong in a recipe's
 * `checks.config['duplicate-utility-functions'].additionalDomainSpecificFunctions`
 * block, NOT in built-in defaults.
 */
export interface DuplicateUtilityFunctionsConfig extends Record<string, unknown> {
  /** Function names that should be skipped (treated as domain-specific by design). */
  additionalDomainSpecificFunctions?: readonly string[];
}

/**
 * Common utility function name patterns
 */
const UTILITY_PATTERNS = [
  /^format[A-Z]/, // formatDate, formatCurrency
  /^parse[A-Z]/, // parseJson, parseDate
  /^is[A-Z]/, // isValid, isEmpty
  /^has[A-Z]/, // hasValue, hasKey
  /^to[A-Z]/, // toString, toNumber
  /^get[A-Z]/, // getValue, getDefault
  /^validate[A-Z]/, // validateEmail, validatePhone
  /^sanitize[A-Z]/, // sanitizeInput, sanitizeHtml
  /^normalize[A-Z]/, // normalizeUrl, normalizeText
  /^debounce/,
  /^throttle/,
  /^sleep/,
  /^delay/,
  /^retry/,
  /^clamp/,
  /^range/,
  /^chunk/,
  /^unique/,
  /^flatten/,
];

/**
 * Minimum function body length (characters) to consider for duplicate detection.
 * Very short functions (1-2 lines) are often trivial and not worth flagging.
 */
const MIN_FUNCTION_BODY_LENGTH = 50;

/**
 * Functions that are intentionally domain-specific and should NOT be flagged
 * as duplicates. Limited to genuinely generic identifiers — config / factory
 * / logger / common type-guard names — that almost any TS codebase will hit.
 *
 * Project-specific names (e.g. opensip's `getCurrentCorrelationId`,
 * `formatDuration`, `getRemoteUrl`, `sanitizeForPrompt`) belong in a recipe's
 * `checks.config['duplicate-utility-functions'].additionalDomainSpecificFunctions`
 * block. The check reads that list via {@link getCheckConfig} and merges it
 * with these defaults.
 */
const DOMAIN_SPECIFIC_FUNCTIONS = new Set([
  // Config / factory pattern - each domain has its own configuration
  'getConfig',
  'getDefaultConfig',
  'getContainer',
  'getFactory',
  // Logger / shared singletons
  'getLogger',
  // Common predicates that have multiple legitimate definitions
  'isPlainObject',
  'isStringArray',
  'isCommentLine',
  'isTestFile',
  'isValidEmail',
  // Common formatter / parser names that vary by input shape
  'formatDate',
  'formatTimestamp',
  'parseArgs',
  // Common validation entry points
  'validateConfig',
  'validateSchema',
  // Common error-message helper
  'getErrorMessage',
  // AST predicates / shared kernel helpers — each layer (engine, lang adapter,
  // graph adapter) legitimately defines its own implementation tuned to its
  // node shape; the architecture rules prevent cross-layer imports.
  'isPropertyAccess',
  'isFunctionLike',
  'getSharedSourceFile',
  'getLineNumber',
  'isReturnValueDiscarded',
  // Plugin / package discovery (mirrored in fitness + simulation discovery walkers)
  'hasPackageJson',
  // Language-adapter parsers and dir normalizers — one per graph-* pack
  // (graph-go, graph-java, graph-python, graph-rust, graph-typescript) by
  // design; cross-pack imports are forbidden by .config/dependency-cruiser.cjs.
  'normalizeProjectDir',
  'parseProject',
  // Tokenizer helper present in several language-adapter strip-comment passes
  'isIdentChar',
  // Assertion validation — fitness engine + simulation engine each own one
  'validateAssertions',
]);

/**
 * Build the effective domain-specific set by merging built-in defaults with
 * the recipe-provided augmentation for `duplicate-utility-functions`.
 */
function buildEffectiveDomainSpecificSet(): ReadonlySet<string> {
  const cfg = getCheckConfig<DuplicateUtilityFunctionsConfig>('duplicate-utility-functions');
  if (
    !cfg.additionalDomainSpecificFunctions ||
    cfg.additionalDomainSpecificFunctions.length === 0
  ) {
    return DOMAIN_SPECIFIC_FUNCTIONS;
  }
  const merged = new Set(DOMAIN_SPECIFIC_FUNCTIONS);
  for (const name of cfg.additionalDomainSpecificFunctions) merged.add(name);
  return merged;
}

interface FunctionInfo {
  name: string;
  line: number;
  file: string;
  bodyHash: string;
  bodyLength: number;
}

/** Map from function name to map of body hash to locations */
type FunctionsByName = Map<string, Map<string, FunctionInfo[]>>;

/**
 * Get unique directories from a list of function locations
 */
function getUniqueDirectories(locations: FunctionInfo[]): Set<string> {
  /* v8 ignore next -- defensive guard */
  if (!Array.isArray(locations)) {
    return new Set();
  }
  return new Set(locations.map((l) => dirname(l.file)));
}

/**
 * Flatten all locations from hash groups into a single array
 */
function flattenHashGroups(hashGroups: Map<string, FunctionInfo[]>): FunctionInfo[] {
  const allLocations: FunctionInfo[] = [];
  if (hashGroups.size === 0) {
    return allLocations;
  }
  for (const locations of hashGroups.values()) {
    if (Array.isArray(locations) && locations.length > 0) {
      allLocations.push(...locations);
    }
  }
  return allLocations;
}

/**
 * Get first location from each hash group (unique implementations)
 */
function getFirstFromEachHashGroup(hashGroups: Map<string, FunctionInfo[]>): FunctionInfo[] {
  const uniqueImpls: FunctionInfo[] = [];
  if (hashGroups.size === 0) {
    return uniqueImpls;
  }
  for (const locations of hashGroups.values()) {
    /* v8 ignore next -- defensive guard */
    if (!Array.isArray(locations) || locations.length === 0) {
      continue;
    }
    const first = locations[0];
    if (first) {
      uniqueImpls.push(first);
    }
  }
  return uniqueImpls;
}

/**
 * Format other files for display in violation message
 */
function formatOtherFiles(locations: FunctionInfo[]): string {
  const otherFiles = locations
    .slice(1)
    .map((l) => basename(l.file))
    .slice(0, 3);
  const moreCount = locations.length > 4 ? ` (+${locations.length - 4} more)` : '';
  return `${otherFiles.join(', ')}${moreCount}`;
}

/**
 * Add a function to the functions-by-name collection
 */
function addFunctionToCollection(functionsByName: FunctionsByName, fn: FunctionInfo): void {
  let nameGroup = functionsByName.get(fn.name);
  if (!nameGroup) {
    nameGroup = new Map();
    functionsByName.set(fn.name, nameGroup);
  }

  let hashGroup = nameGroup.get(fn.bodyHash);
  if (!hashGroup) {
    hashGroup = [];
    nameGroup.set(fn.bodyHash, hashGroup);
  }

  hashGroup.push(fn);
}

/**
 * Check if locations represent a valid duplicate across multiple directories.
 */
function isValidCrossDirectoryDuplicate(locations: FunctionInfo[]): boolean {
  /* v8 ignore next -- defensive guard */
  if (!Array.isArray(locations) || locations.length <= 1) {
    return false;
  }
  const locationDirs = getUniqueDirectories(locations);
  return locationDirs.size > 1;
}

/**
 * Remove single-line comments from code
 */
function removeSingleLineComments(code: string): string {
  return code
    .split('\n')
    .map((line) => {
      const commentIndex = line.indexOf('//');
      return commentIndex === -1 ? line : line.slice(0, commentIndex);
    })
    .join('\n');
}

/**
 * Remove multi-line comments from code
 * Uses iterative approach to avoid regex backtracking issues.
 */
function removeMultiLineComments(code: string): string {
  let result = '';
  let i = 0;
  while (i < code.length) {
    if (code[i] === '/' && code[i + 1] === '*') {
      const endIndex = code.indexOf('*/', i + 2);
      if (endIndex === -1) {
        break;
      }
      i = endIndex + 2;
    } else {
      result += code[i];
      i++;
    }
  }
  return result;
}

/**
 * Normalize function body for comparison.
 * Removes whitespace, comments, and normalizes identifiers.
 */
function normalizeBody(body: string): string {
  let normalized = body;
  normalized = removeSingleLineComments(normalized);
  normalized = removeMultiLineComments(normalized);
  normalized = normalized.replaceAll(/\s+/g, ' ');
  normalized = normalized.trim();
  return normalized;
}

/**
 * Generate a hash of the normalized function body.
 * Uses SHA-256 for content-addressable deduplication (not for security purposes).
 */
function hashBody(body: string): string {
  const normalized = normalizeBody(body);
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Check if function name matches utility patterns. The `domainSpecific`
 * argument is the effective allowlist (built-in defaults plus any
 * recipe-supplied augmentation).
 */
function isUtilityFunction(name: string, domainSpecific: ReadonlySet<string>): boolean {
  if (domainSpecific.has(name)) {
    return false;
  }
  return UTILITY_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Extract utility functions from a file with their body hashes
 */
function extractUtilityFunctionsWithBody(
  filePath: string,
  content: string,
  domainSpecific: ReadonlySet<string>,
): FunctionInfo[] {
  const functions: FunctionInfo[] = [];

  try {
    const sourceFile = getSharedSourceFile(filePath, content);
    /* v8 ignore next -- defensive guard */
    if (!sourceFile) return [];

    const visit = (node: ts.Node) => {
      // Check function declarations
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        const name = node.name.text;
        if (isUtilityFunction(name, domainSpecific)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          const body = node.body.getText(sourceFile);
          functions.push({
            name,
            line: line + 1,
            file: filePath,
            bodyHash: hashBody(body),
            bodyLength: body.length,
          });
        }
      }

      // Check arrow functions assigned to variables
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isArrowFunction(node.initializer)
      ) {
        const name = node.name.text;
        if (isUtilityFunction(name, domainSpecific)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
          const body = node.initializer.body.getText(sourceFile);
          functions.push({
            name,
            line: line + 1,
            file: filePath,
            bodyHash: hashBody(body),
            bodyLength: body.length,
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    /* v8 ignore next 1 -- defensive catch: parse failures already handled */
  } catch {
    // @swallow-ok Ignore parse errors
  }

  return functions;
}

/**
 * Create a violation for identical implementations
 */
function createIdenticalViolation(name: string, locations: FunctionInfo[]): CheckViolation {
  const first = locations[0];
  if (!first) {
    throw new Error(`createIdenticalViolation called with empty locations array for '${name}'`);
  }
  const otherFilesStr = formatOtherFiles(locations);

  return {
    line: first.line,
    message: `Utility function '${name}' has identical implementation in ${locations.length} locations`,
    severity: 'warning',
    suggestion: `Move '${name}' to packages/shared/backend/foundation/utils/ or a relevant domain utils module. Also in: ${otherFilesStr}`,
    type: 'duplicate-utility-identical',
    match: name,
    filePath: first.file,
  };
}

/**
 * Create a violation for similar implementations (same name, different body)
 */
function createSimilarViolation(name: string, uniqueImpls: FunctionInfo[]): CheckViolation {
  const first = uniqueImpls[0];
  if (!first) {
    throw new Error(`createSimilarViolation called with empty uniqueImpls array for '${name}'`);
  }
  const otherFilesStr = formatOtherFiles(uniqueImpls);
  const numImplementations = uniqueImpls.length;

  return {
    line: first.line,
    message: `Utility function '${name}' has ${numImplementations} different implementations - consider consolidation with options`,
    severity: 'warning',
    suggestion: `Create a unified '${name}' function with configurable options in packages/shared/backend/foundation/utils/. Different implementations found in: ${otherFilesStr}`,
    type: 'duplicate-utility-similar',
    match: name,
    filePath: first.file,
  };
}

async function collectFunctionsFromFiles(
  files: FileAccessor,
  domainSpecific: ReadonlySet<string>,
): Promise<FunctionsByName> {
  const functionsByName: FunctionsByName = new Map();

  for (const filePath of files.paths) {
    try {
      // @fitness-ignore-next-line performance-anti-patterns -- sequential file reading to control memory; FileAccessor is lazy
      const content = await files.read(filePath);
      const functions = extractUtilityFunctionsWithBody(filePath, content, domainSpecific);
      const validFunctions = functions.filter((fn) => fn.bodyLength >= MIN_FUNCTION_BODY_LENGTH);

      for (const fn of validFunctions) {
        void addFunctionToCollection(functionsByName, fn);
      }
      /* v8 ignore next 1 -- defensive catch: parse failures already handled */
    } catch {
      // @swallow-ok Skip unreadable files
    }
  }

  return functionsByName;
}

function findIdenticalViolations(
  name: string,
  hashGroups: Map<string, FunctionInfo[]>,
): CheckViolation[] {
  const violations: CheckViolation[] = [];

  for (const locations of hashGroups.values()) {
    if (isValidCrossDirectoryDuplicate(locations)) {
      violations.push(createIdenticalViolation(name, locations));
    }
  }

  return violations;
}

function findSimilarViolation(
  name: string,
  hashGroups: Map<string, FunctionInfo[]>,
): CheckViolation | null {
  if (hashGroups.size <= 1) {
    return null;
  }

  const uniqueImpls = getFirstFromEachHashGroup(hashGroups);
  /* v8 ignore next -- defensive guard */
  if (!Array.isArray(uniqueImpls) || uniqueImpls.length <= 1) {
    return null;
  }

  const implDirs = getUniqueDirectories(uniqueImpls);
  if (implDirs.size <= 1) {
    return null;
  }

  return createSimilarViolation(name, uniqueImpls);
}

function processFunctionGroup(
  name: string,
  hashGroups: Map<string, FunctionInfo[]>,
): CheckViolation[] {
  const allLocations = flattenHashGroups(hashGroups);
  const dirs = getUniqueDirectories(allLocations);

  if (dirs.size <= 1 || hashGroups.size === 0) {
    return [];
  }

  const violations: CheckViolation[] = [...findIdenticalViolations(name, hashGroups)];

  const similarViolation = findSimilarViolation(name, hashGroups);
  if (similarViolation) {
    violations.push(similarViolation);
  }

  return violations;
}

/**
 * Check: quality/duplicate-utility-functions
 *
 * Detects utility functions that should be consolidated across the codebase.
 * Reports two types of issues:
 * - IDENTICAL: Same name, same implementation (true duplicates)
 * - SIMILAR: Same name, different implementation (consolidation opportunities)
 */
export const duplicateUtilityFunctions = defineCheck({
  id: 'aa303a1e-f3f8-4a11-ade2-9e29af89c299',
  slug: 'duplicate-utility-functions',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Detect duplicate and similar utility functions',
  longDescription: `**Purpose:** Detects utility functions that are duplicated or similarly named across the codebase, flagging consolidation opportunities into shared packages.

**Detects:** Cross-file analysis using TypeScript AST extraction and SHA-256 body hashing.
- **Identical duplicates:** Same-named utility functions with identical normalized bodies in different directories
- **Similar implementations:** Same-named utility functions with different bodies across directories (consolidation with options pattern)
- Targets functions matching utility name patterns: \`format*\`, \`parse*\`, \`is*\`, \`has*\`, \`to*\`, \`get*\`, \`validate*\`, \`sanitize*\`, \`normalize*\`, \`debounce\`, \`throttle\`, \`sleep\`, \`retry\`, etc.
- Skips domain-specific functions listed in \`DOMAIN_SPECIFIC_FUNCTIONS\` and bodies under 50 characters

**Why it matters:** Duplicated utilities create maintenance risk and inconsistent behavior. A single shared implementation in \`foundation/utils\` ensures consistent behavior and reduces code volume.

**Scope:** General best practice`,
  tags: ['quality', 'dry', 'utilities', 'duplication'],
  fileTypes: ['ts'],

  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const domainSpecific = buildEffectiveDomainSpecificSet();
    const functionsByName = await collectFunctionsFromFiles(files, domainSpecific);
    const violations: CheckViolation[] = [];

    for (const [name, hashGroups] of functionsByName) {
      // @fitness-ignore-next-line performance-anti-patterns -- spread aggregates small violation arrays from pure function
      violations.push(...processFunctionGroup(name, hashGroups));
    }

    return violations;
  },
});
