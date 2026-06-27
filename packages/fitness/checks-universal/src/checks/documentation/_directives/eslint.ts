/**
 * @fileoverview ESLint directive parser
 * (`eslint-disable`, `eslint-disable-next-line`, `eslint-disable-line`).
 *
 * Extracted from `directive-audit.ts` in Phase C4.
 */

import type { DirectiveInfo, DirectiveScope } from './types.js';

const ESLINT_DISABLE_NEXT_LINE = 'eslint-disable-next-line';
const ESLINT_DISABLE_LINE = 'eslint-disable-line';

function determineESLintScope(text: string): DirectiveScope {
  if (text.includes(ESLINT_DISABLE_NEXT_LINE)) {
    return 'next-line';
  }
  if (text.includes(ESLINT_DISABLE_LINE)) {
    return 'same-line';
  }
  return 'file';
}

function parseRulesAndReason(rulesAndReasonRaw: string | undefined): {
  rules: string[];
  reason: string;
} {
  const rulesAndReason = rulesAndReasonRaw?.trim() ?? '';
  const parts = rulesAndReason.split('--');
  const rulesPart = parts[0]?.trim() ?? '';
  const reasonPart = parts[1]?.trim() ?? '';

  const rules = rulesPart
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r && r !== '*');

  return { rules, reason: reasonPart };
}

interface CreateESLintDirectiveOptions {
  rule: string;
  scope: DirectiveScope;
  lineNumber: number;
  file: string;
  filePath: string;
  reason: string;
  rawLine: string;
}

function createESLintDirective(options: CreateESLintDirectiveOptions): DirectiveInfo {
  const { rule, scope, lineNumber, file, filePath, reason, rawLine } = options;
  return {
    file,
    filePath,
    line: lineNumber,
    source: 'eslint',
    scope,
    rule,
    reason,
    raw: rawLine.trim(),
  };
}

interface AddESLintDirectivesOptions {
  rulesAndReasonRaw: string | undefined;
  scope: DirectiveScope;
  rawLine: string;
  lineNumber: number;
  file: string;
  filePath: string;
  directives: DirectiveInfo[];
}

function addESLintDirectives(options: AddESLintDirectivesOptions): void {
  const { rulesAndReasonRaw, scope, rawLine, lineNumber, file, filePath, directives } = options;
  if (!Array.isArray(directives)) {
    return;
  }
  const { rules, reason } = parseRulesAndReason(rulesAndReasonRaw);

  if (rules.length === 0) {
    directives.push(
      createESLintDirective({
        rule: '*',
        scope,
        lineNumber,
        file,
        filePath,
        reason,
        rawLine,
      }),
    );
    return;
  }

  for (const rule of rules) {
    directives.push(
      createESLintDirective({
        rule: `eslint/${rule}`,
        scope,
        lineNumber,
        file,
        filePath,
        reason,
        rawLine,
      }),
    );
  }
}

interface ProcessESLintCommentsOptions {
  line: string;
  lineNumber: number;
  file: string;
  filePath: string;
  directives: DirectiveInfo[];
}

function processESLintBlockComments(options: ProcessESLintCommentsOptions): void {
  const { line, lineNumber, file, filePath, directives } = options;
  if (!Array.isArray(directives)) {
    return;
  }
  // Find block comments: /* eslint-disable[-next-line|-line] rules */
  let searchStart = 0;
  while (searchStart < line.length) {
    const blockStart = line.indexOf('/*', searchStart);
    if (blockStart === -1) {
      return;
    }

    const blockEnd = line.indexOf('*/', blockStart + 2);
    if (blockEnd === -1) {
      return;
    }

    const blockContent = line.slice(blockStart + 2, blockEnd);
    // Bounded quantifiers prevent ReDoS.
    const eslintMatch = /\s{0,5}eslint-disable(?:-next-line|-line)?\s{1,5}([^*]{1,500})/.exec(
      blockContent,
    );

    if (eslintMatch) {
      const scope = determineESLintScope(blockContent);
      addESLintDirectives({
        rulesAndReasonRaw: eslintMatch[1],
        scope,
        rawLine: line,
        lineNumber,
        file,
        filePath,
        directives,
      });
    }

    searchStart = blockEnd + 2;
  }
}

function processESLintLineComments(options: ProcessESLintCommentsOptions): void {
  const { line, lineNumber, file, filePath, directives } = options;
  if (!Array.isArray(directives)) {
    return;
  }
  // Find line comments: // eslint-disable[-next-line|-line] rules
  const commentStart = line.indexOf('//');
  if (commentStart === -1) {
    return;
  }

  const afterComment = line.slice(commentStart + 2);
  // Bounded quantifiers prevent ReDoS.
  const eslintMatch = /\s{0,5}eslint-disable(?:-next-line|-line)\s{1,5}(.{1,500})$/.exec(
    afterComment,
  );

  if (eslintMatch) {
    const scope = determineESLintScope(afterComment);
    addESLintDirectives({
      rulesAndReasonRaw: eslintMatch[1],
      scope,
      rawLine: line,
      lineNumber,
      file,
      filePath,
      directives,
    });
  }
}

function isFileLevelDisable(line: string): boolean {
  const pattern = '/* eslint-disable */';
  return line.includes(pattern) || line.includes('/*eslint-disable*/');
}

export function parseESLintDirectives(
  content: string,
  filePath: string,
  file: string,
): DirectiveInfo[] {
  const directives: DirectiveInfo[] = [];
  const lines = content.split('\n');

  for (const [i, line] of lines.entries()) {
    if (line === undefined) {
      continue;
    }

    const lineNumber = i + 1;

    // File-level eslint-disable at start of file (first 50 lines)
    if (i < 50 && isFileLevelDisable(line)) {
      directives.push({
        file,
        filePath,
        line: lineNumber,
        source: 'eslint',
        scope: 'file',
        rule: '*',
        reason: '',
        raw: line.trim(),
      });
    } else {
      processESLintBlockComments({
        line,
        lineNumber,
        file,
        filePath,
        directives,
      });
      processESLintLineComments({
        line,
        lineNumber,
        file,
        filePath,
        directives,
      });
    }
  }

  return directives;
}
