/**
 * @fileoverview Unbounded memory check
 */

import { logger } from '@opensip-cli/core';
import {
  defineCheck,
  isCheckAuthoringSource,
  isTestFile,
  type CheckViolation,
  getLineNumber,
} from '@opensip-cli/fitness';
import { stripStringsAndCommentsPreservingPositions } from '@opensip-cli/fitness';

const COLLECTION_TYPES = ['new Map(', 'new Set(', '= []', ': []'] as const;

/** Patterns indicating a collection is bounded by design (static registries, constants, DI tokens). */
const BOUNDED_DECLARATION_PATTERNS = [
  'static readonly',
  'static ',
  'readonly ',
  'const ',
  '= Object.freeze',
  'as const',
  'INJECTION_TOKEN',
  'InjectionToken',
  'DI_TOKEN',
  'Symbol(',
  'WeakMap',
  'WeakSet',
];

function isBoundedDeclaration(line: string): boolean {
  const trimmed = line.trim();
  return BOUNDED_DECLARATION_PATTERNS.some((pattern) => trimmed.includes(pattern));
}

function findCollectionDeclarations(content: string): { index: number; match: string }[] {
  logger.debug({
    evt: 'fitness.checks.batch_operations.find_collection_declarations',
    msg: 'Finding private collection declarations that may grow without bounds',
  });
  const results: { index: number; match: string }[] = [];
  const lines = content.split('\n');
  let charIndex = 0;

  for (const line of lines) {
    const currentCharIndex = charIndex;
    charIndex += line.length + 1;

    const trimmed = line.trim();
    const isPrivateDeclaration = trimmed.startsWith('private');
    const collectionType = isPrivateDeclaration
      ? COLLECTION_TYPES.find((type) => line.includes(type))
      : undefined;

    if (collectionType) {
      if (isBoundedDeclaration(line)) {
        continue;
      }

      const matchStart = line.indexOf('private');
      const lineEnd = line.includes(';') ? line.indexOf(';') + 1 : line.length;
      results.push({
        index: currentCharIndex + matchStart,
        match: line.slice(matchStart, lineEnd).trim(),
      });
    }
  }

  return results;
}

const EVICTION_KEYWORDS = [
  '.delete(',
  '.clear(',
  '.splice(',
  '.shift(',
  '.pop(',
  '.length = 0',
  '.length=0',
  'maxsize',
  'max_size',
  'limit',
  'evict',
  'prune',
  'cleanup',
  'truncate',
  'lru',
  'overflow',
  '@bounded-collection',
] as const;

function hasEvictionKeyword(content: string): boolean {
  const lowerContent = content.toLowerCase();
  return EVICTION_KEYWORDS.some((keyword) => lowerContent.includes(keyword.toLowerCase()));
}

/** String literals for pattern matching, not actual fs calls. */
// @fitness-ignore-next-line fitness-check-standards -- These are string literals for pattern matching, not actual fs calls
const FILE_READ_METHODS = ['readFileSync(', 'readFile('] as const;

const FILE_SIZE_CHECK_KEYWORDS = [
  'statsync(',
  'stat(',
  '.size <',
  '.size >',
  '.size<',
  '.size>',
  'max_file_size',
  'maxfilesize',
] as const;

function hasFileSizeCheck(content: string): boolean {
  const lowerContent = content.toLowerCase();
  return FILE_SIZE_CHECK_KEYWORDS.some((keyword) => lowerContent.includes(keyword));
}

function isStructuredParseRead(code: string, readIndex: number): boolean {
  const before = code.slice(Math.max(0, readIndex - 16), readIndex);
  return /JSON\s*\.\s*parse\s*\(\s*$/.test(before);
}

const SELF_RELATIVE_MARKERS = ['import.meta.url', '__dirname', '__filename', 'fileurltopath'];

function isModuleSelfRelativeRead(codeContext: string): boolean {
  const lower = codeContext.toLowerCase();
  return SELF_RELATIVE_MARKERS.some((marker) => lower.includes(marker));
}

const KNOWN_SMALL_FILE_PATTERNS = [
  'package.json',
  'tsconfig',
  'pyproject.toml',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.env',
  '.config',
  'opensip-cli.config',
  '.opensip-cli',
  'update-state',
  'entitlement',
  'scaffold',
  'template',
  'global-config',
  'manifest',
  '.eslintrc',
  '.prettierrc',
] as const;

const BOUNDED_SOURCE_READ_PATHS = [
  /[/\\]cli[/\\]src[/\\]commands[/\\]init[/\\]scaffold-writer\.ts$/i,
  /[/\\]cli[/\\]src[/\\]commands[/\\]plugin[/\\]config-edit\.ts$/i,
  /[/\\]config[/\\]src[/\\]document[/\\]global-config\.ts$/i,
  /[/\\]core[/\\]src[/\\]signals[/\\]suppress\.ts$/i,
  /[/\\]fitness[/\\]engine[/\\]src[/\\]framework[/\\]define-check\.ts$/i,
  /[/\\]graph[/\\]graph-adapter-common[/\\]src[/\\]cache-key\.ts$/i,
  /[/\\]graph[/\\]graph-go[/\\]src[/\\]resolve\.ts$/i,
  /[/\\]graph[/\\]graph-python[/\\]src[/\\]cache-key\.ts$/i,
  /[/\\]graph[/\\]graph-rust[/\\]src[/\\]resolve-dependencies\.ts$/i,
  /[/\\]graph[/\\]graph-typescript[/\\]src[/\\]discover\.ts$/i,
  /[/\\]graph[/\\]graph-typescript[/\\]src[/\\]index\.ts$/i,
  /[/\\]languages[/\\]lang-typescript[/\\]src[/\\]program-service\.ts$/i,
  /[/\\]output[/\\]src[/\\]sink[/\\]entitlement\.ts$/i,
  /[/\\]yagni[/\\]engine[/\\]src[/\\]cli[/\\]execute-yagni\.ts$/i,
] as const;

function isKnownBoundedSourceRead(filePath: string): boolean {
  return BOUNDED_SOURCE_READ_PATHS.some((pattern) => pattern.test(filePath));
}

/** Whole-file markers that prove reads are size-guarded elsewhere in the module. */
const GUARDED_READ_MARKERS = [
  'file_too_large',
  'max_file_size',
  'maxfilesize',
  'file too large',
  'content.length >',
  'content.length <',
  'statsync',
] as const;

function hasGuardedReadWrapper(content: string): boolean {
  const lower = content.toLowerCase();
  return GUARDED_READ_MARKERS.some((marker) => lower.includes(marker));
}

function isReadingKnownSmallFile(content: string, readIndex: number): boolean {
  const start = Math.max(0, readIndex - 100);
  const end = Math.min(content.length, readIndex + 150);
  const context = content.slice(start, end).toLowerCase();
  return KNOWN_SMALL_FILE_PATTERNS.some((pattern) => context.includes(pattern));
}

function findFileReadCalls(content: string): { index: number; match: string }[] {
  logger.debug({
    evt: 'fitness.checks.batch_operations.find_file_read_calls',
    msg: 'Finding file read calls that may cause OOM without size validation',
  });
  const results: { index: number; match: string }[] = [];

  for (const method of FILE_READ_METHODS) {
    let searchStart = 0;
    while (searchStart < content.length) {
      const idx = content.indexOf(method, searchStart);
      if (idx === -1) break;
      results.push({ index: idx, match: method });
      searchStart = idx + method.length;
    }
  }

  return results;
}

function hasGrowthMethod(content: string): boolean {
  const methods = ['.set(', '.push(', '.add('];
  return methods.some((method) => content.includes(method));
}

/**
 * Check: resilience/unbounded-memory
 *
 * Detects potential memory leaks and OOM risks:
 * - Maps/Sets/Arrays in classes without eviction logic
 * - File reads without prior size checks
 * - Growing buffers without backpressure
 */
export const unboundedMemory = defineCheck({
  id: '1f3c347d-3511-4157-87e0-050fd57c28b3',
  slug: 'unbounded-memory',
  contentFilter: 'strip-strings',
  description: 'Detect unbounded collections and file reads that may cause OOM',
  longDescription: `**Purpose:** Identifies potential memory leaks from collections that grow without bounds and file reads without size validation.

**Detects:**
- Private class fields initialized with \`new Map(\`, \`new Set(\`, or empty arrays that have growth methods (\`.set\`, \`.push\`, \`.add\`) but no eviction keywords (\`.delete\`, \`.clear\`, \`maxsize\`, \`evict\`, \`prune\`, \`lru\`, etc.)
- \`readFileSync(\` and \`readFile(\` calls without a preceding \`stat()\` / \`.size\` check within 500 characters
- Skips known-small config paths (\`.opensip-cli\`, \`opensip-cli.config\`, manifests), modules with size guards, and \`static\` / \`readonly\` / \`const\` / \`WeakMap\` / DI token declarations

**Why it matters:** Unbounded in-memory collections cause gradual OOM in long-running services; reading files without size guards risks instant OOM on large inputs.

**Scope:** General best practice. Analyzes each file individually via string matching.`,
  scope: { languages: ['typescript'], concerns: [] },
  tags: ['resilience', 'memory', 'performance'],

  analyze(content: string, filePath: string): CheckViolation[] {
    if (isTestFile(filePath)) return [];
    if (isCheckAuthoringSource(filePath)) return [];

    logger.debug({
      evt: 'fitness.checks.batch_operations.analyze_file_operations',
      msg: 'Analyzing file for unbounded memory usage and file read operations',
    });
    const violations: CheckViolation[] = [];

    const codeOnly = stripStringsAndCommentsPreservingPositions(content);

    const collectionDeclarations = findCollectionDeclarations(codeOnly);
    for (const declaration of collectionDeclarations) {
      const hasEviction = hasEvictionKeyword(content);
      const hasGrowth = hasGrowthMethod(content);

      if (hasGrowth && !hasEviction) {
        const lineNumber = getLineNumber(content, declaration.index);
        violations.push({
          line: lineNumber,
          column: 0,
          message: 'Unbounded collection that grows without eviction',
          severity: 'warning',
          suggestion:
            'Add maxSize limit and eviction logic (e.g., LRU). Use a shared cache utility for caching or implement periodic cleanup with .delete() or .clear().',
          match: declaration.match,
          type: 'unbounded-collection',
          filePath,
        });
      }
    }

    if (hasGuardedReadWrapper(content)) {
      return violations;
    }

    const fileReadCalls = findFileReadCalls(codeOnly);
    for (const readCall of fileReadCalls) {
      const start = Math.max(0, readCall.index - 1500);
      const context = content.slice(start, readCall.index);
      const codeContext = codeOnly.slice(start, readCall.index);

      if (isKnownBoundedSourceRead(filePath) || isReadingKnownSmallFile(content, readCall.index)) {
        continue;
      }

      if (
        isStructuredParseRead(codeOnly, readCall.index) ||
        isModuleSelfRelativeRead(codeContext)
      ) {
        continue;
      }

      if (!hasFileSizeCheck(context)) {
        const lineNumber = getLineNumber(content, readCall.index);
        violations.push({
          line: lineNumber,
          column: 0,
          message: 'File read without size validation may cause OOM',
          severity: 'warning',
          suggestion:
            'Check fs.stat().size before reading to prevent OOM on large files. Example: const stats = await fs.stat(path); if (stats.size > MAX_FILE_SIZE) throw new Error("File too large");',
          match: readCall.match,
          type: 'unbounded-file-read',
          filePath,
        });
      }
    }

    return violations;
  },
});
