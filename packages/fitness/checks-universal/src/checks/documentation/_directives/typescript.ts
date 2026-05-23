/**
 * @fileoverview TypeScript directive parser (`@ts-expect-error`, etc.).
 *
 * Extracted from `directive-audit.ts` in Phase C4 — the parsers used
 * to live inline in the check, but the four grammars are best read
 * (and tested) as siblings.
 */

import type { DirectiveInfo } from './types.js'

const TS_DIRECTIVE_KEYWORD = '@ts-expect-error'
const TS_EXPECT_ERROR_KEYWORD = '@ts-expect-error'

function extractTsDirectiveAndReason(
  line: string,
): { directive: string; reason: string } | null {
  let directiveStart = line.indexOf(TS_DIRECTIVE_KEYWORD)
  let directive = TS_DIRECTIVE_KEYWORD

  if (directiveStart === -1) {
    directiveStart = line.indexOf(TS_EXPECT_ERROR_KEYWORD)
    directive = TS_EXPECT_ERROR_KEYWORD
  }

  if (directiveStart === -1) {
    return null
  }

  // Must be in a `//` comment.
  const beforeDirective = line.slice(0, directiveStart)
  if (!beforeDirective.includes('//')) {
    return null
  }

  // Extract reason after directive (after : or - or em-dash).
  // Bounded quantifiers prevent ReDoS.
  const afterDirective = line.slice(directiveStart + directive.length)
  const separatorMatch = /^\s{0,5}[:-—]\s{0,5}(.{0,500})/.exec(afterDirective)
  const reason = separatorMatch?.[1]?.trim() ?? ''

  return { directive, reason }
}

export function parseTypeScriptDirectives(
  content: string,
  filePath: string,
  file: string,
): DirectiveInfo[] {
  const directives: DirectiveInfo[] = []
  const lines = content.split('\n')

  for (const [i, line] of lines.entries()) {
    if (line === undefined) continue

    const result = extractTsDirectiveAndReason(line)
    if (result) {
      directives.push({
        file,
        filePath,
        line: i + 1,
        source: 'typescript',
        scope: 'next-line',
        rule: result.directive,
        reason: result.reason,
        raw: line.trim(),
      })
    }
  }

  return directives
}
