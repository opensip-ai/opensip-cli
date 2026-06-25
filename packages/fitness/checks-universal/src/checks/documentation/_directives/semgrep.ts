// @fitness-ignore-file semgrep-justifications -- this file's job is to parse nosemgrep directives; example nosemgrep strings appear in JSDoc by necessity
/**
 * @fileoverview Semgrep directive parser (`nosemgrep`).
 *
 * Extracted from `directive-audit.ts` in Phase C4.
 */

import { collectDirectives } from './shared.js';

import type { DirectiveInfo } from './types.js';

/**
 * Extract semgrep rule ID and reason from a nosemgrep directive line.
 *
 * Formats:
 * - `// nosemgrep: rule.id -- reason`
 * - `// nosemgrep: rule.id`
 * - `// nosemgrep`
 */
function extractSemgrepDirective(
  line: string,
  lineIndex: number,
  filePath: string,
  file: string,
): DirectiveInfo | null {
  const nosemgrepMarker = 'nosemgrep';

  // Find the nosemgrep marker in a comment
  const commentIdx = line.indexOf('//');
  if (commentIdx === -1) {
    return null;
  }

  const afterComment = line.slice(commentIdx + 2).trim();
  if (!afterComment.startsWith(nosemgrepMarker)) {
    return null;
  }

  const afterMarker = afterComment.slice(nosemgrepMarker.length);

  // Extract rule ID and reason
  let ruleId = '*'; // Default to all rules
  let reason = '';

  // Check for : separator (rule ID follows)
  if (afterMarker.startsWith(':')) {
    const afterColon = afterMarker.slice(1).trim();

    // Check for -- separator (reason follows)
    const reasonSeparator = afterColon.indexOf('--');
    if (reasonSeparator === -1) {
      ruleId = afterColon.trim() || '*';
    } else {
      ruleId = afterColon.slice(0, reasonSeparator).trim() || '*';
      reason = afterColon.slice(reasonSeparator + 2).trim();
    }
  } else if (afterMarker.trim().startsWith('--')) {
    // Just a reason, no rule ID
    reason = afterMarker.trim().slice(2).trim();
  }

  return {
    file,
    filePath,
    line: lineIndex + 1,
    source: 'semgrep',
    scope: 'next-line',
    rule: `semgrep/${ruleId}`,
    reason,
    raw: line.trim(),
  };
}

export function parseSemgrepDirectives(
  content: string,
  filePath: string,
  file: string,
): DirectiveInfo[] {
  return collectDirectives(content, filePath, file, extractSemgrepDirective);
}
