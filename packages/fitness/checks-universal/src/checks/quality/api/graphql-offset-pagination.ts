// @fitness-ignore-file correlation-id-coverage -- Fitness check analysis function; no network operations requiring correlation
/**
 * @fileoverview Detect offset-based pagination in GraphQL queries
 *
 * Offset pagination produces unstable results when data changes between page
 * fetches (the "shifting page" problem). Cursor-based pagination (keyset via
 * where clause) provides stable results.
 */

import { defineCheck, getLineNumber, type CheckViolation } from '@opensip-cli/fitness';

import {
  createCodeMask,
  decodeJavaScriptStaticText,
  findCodeMatches,
  findTaggedTemplateStarts,
  templateRawSpans,
  type SourceSpan,
} from '../../code-aware-match.js';

const OFFSET_VAR_AT_START_PATTERN = /^\$offset\s*:\s*Int/;
const GQL_TEMPLATE_START_PATTERN = /\bgql(?:\s*<[^`\n]+>)?\s*`/;
const ASSIGNED_TEMPLATE_START_PATTERN = /=\s*`/;

function rawText(content: string, spans: readonly SourceSpan[]): string {
  // Keep interpolation boundaries visible. Concatenating raw fragments would
  // turn `que${part}ry` into the static token `query`.
  return spans
    .map((span) => decodeJavaScriptStaticText(content.slice(span.start, span.end)))
    .join('\0');
}

function openingBacktick(match: RegExpExecArray): number {
  return match.index + match[0].lastIndexOf('`');
}

function templateStartMatches(
  pattern: RegExp,
  content: string,
  codeMask: string,
): readonly RegExpExecArray[] {
  const matches = [
    ...findCodeMatches(pattern, codeMask, codeMask),
    ...findCodeMatches(pattern, content, codeMask),
  ];
  return [...new Map(matches.map((match) => [openingBacktick(match), match])).values()];
}

function graphqlTemplateSpans(
  filePath: string,
  content: string,
  codeMask: string,
): readonly (readonly SourceSpan[])[] {
  // Search the position-preserving code view so legal comments between a tag
  // or assignment and its template delimiter behave like whitespace.
  const taggedStarts = new Set([
    ...findTaggedTemplateStarts(filePath, content, 'gql'),
    ...templateStartMatches(GQL_TEMPLATE_START_PATTERN, content, codeMask).map(openingBacktick),
  ]);
  const tagged = [...taggedStarts].map((start) => templateRawSpans(content, codeMask, start));
  const assigned = templateStartMatches(ASSIGNED_TEMPLATE_START_PATTERN, content, codeMask)
    .map((match) => templateRawSpans(content, codeMask, openingBacktick(match)))
    .filter((spans) => /(?:query|mutation|subscription)\s+\w+/.test(rawText(content, spans)));
  return [...tagged, ...assigned];
}

function findOffsetIndexes(
  content: string,
  templateSpans: readonly (readonly SourceSpan[])[],
): number[] {
  const indexes = new Set<number>();
  for (const spans of templateSpans) {
    for (const span of spans) {
      const fragment = content.slice(span.start, span.end);
      for (let index = 0; index < fragment.length; index++) {
        if (fragment[index] !== '$' && fragment[index] !== '\\') continue;
        if (OFFSET_VAR_AT_START_PATTERN.test(decodeJavaScriptStaticText(fragment.slice(index)))) {
          indexes.add(span.start + index);
        }
      }
    }
  }
  return [...indexes].sort((left, right) => left - right);
}

export const graphqlOffsetPagination = defineCheck({
  id: '0ef4c33d-48e6-4bb1-871b-6ac7c1b579e9',
  slug: 'graphql-offset-pagination',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Detect $offset variables in GraphQL queries that indicate offset-based pagination',
  longDescription: `**Purpose:** Flags GraphQL queries that use offset-based pagination, which produces unstable results when data changes between page fetches.

**Detects:**
- \`$offset: Int\` variable declarations (matched by \`/\\$offset\\s*:\\s*Int/\`) inside \`gql\\\`\` template literals

**Why it matters:** Offset pagination causes the "shifting page" problem where inserts or deletes between fetches cause items to be skipped or duplicated. Cursor-based (keyset) pagination provides stable results.

**Scope:** General best practice. Analyzes each file individually using line-by-line text scanning within \`gql\\\`\` template boundaries.`,
  tags: ['quality', 'graphql', 'pagination', 'api'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    const codeMask = createCodeMask(filePath, content);
    const offsets = findOffsetIndexes(content, graphqlTemplateSpans(filePath, content, codeMask));
    return offsets.map((index) => ({
      filePath,
      line: getLineNumber(content, index),
      severity: 'error',
      message: 'GraphQL query uses offset-based pagination ($offset: Int).',
      suggestion:
        'Use cursor-based pagination (keyset via where clause) instead of offset for stable results during data changes.',
    }));
  },
});
