/**
 * Findings component — renders detailed check violations grouped by check.
 *
 * Per-check cap (DEFAULT_VIOLATIONS_PER_CHECK): when a check reports many
 * violations (200+ is common on dense repos or first-run fit-checks),
 * rendering every one through Ink's React tree becomes visibly slow —
 * Ink reconciles the full tree on every frame and flushes ANSI escape
 * sequences for every element. Capping keeps the terminal render
 * instant; exhaustive output stays available via `--json` (machine
 * readable) or `opensip-tools dashboard` (HTML).
 */

import { useTheme } from '@opensip-tools/cli-ui';
import { type CheckOutput } from '@opensip-tools/contracts';
import { Text, Box } from 'ink';
import React from 'react';


/**
 * Hard cap on how many violations a single check renders inline.
 * Tuned to keep the terminal-visible section under a reasonable page
 * budget; the "N more hidden" footer tells the user to re-run with
 * `--json` when they want the complete set.
 */
const DEFAULT_VIOLATIONS_PER_CHECK = 25;

export interface FindingsProps {
  readonly checks: readonly CheckOutput[];
  /** Override the per-check violation cap. Pass `Infinity` to show everything. */
  readonly maxViolationsPerCheck?: number;
}

interface CheckCounts {
  errorCount: number;
  warningCount: number;
}

function countByseverity(check: CheckOutput): CheckCounts {
  let errorCount = 0;
  let warningCount = 0;
  for (const f of check.findings) {
    if (f.severity === 'error') errorCount++;
    else warningCount++;
  }
  return { errorCount, warningCount };
}

export function Findings({ checks, maxViolationsPerCheck = DEFAULT_VIOLATIONS_PER_CHECK }: FindingsProps): React.ReactElement {
  const theme = useTheme();

  const total = checks.reduce((sum, c) => {
    const { errorCount, warningCount } = countByseverity(c);
    return sum + errorCount + warningCount + (c.error ? 1 : 0);
  }, 0);

  const relevant = checks.filter((c) => {
    const { errorCount, warningCount } = countByseverity(c);
    return errorCount > 0 || warningCount > 0 || c.error;
  });

  const anyTruncated = relevant.some(
    (c) => c.findings.length > maxViolationsPerCheck,
  );

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>
        <Text bold>Findings</Text>
        {' '}
        <Text dimColor>({total})</Text>
        :
      </Text>
      <Text> </Text>
      {relevant.map((check) => {
        const { errorCount, warningCount } = countByseverity(check);
        const count = errorCount + warningCount + (check.error ? 1 : 0);
        const visible = check.findings.slice(0, maxViolationsPerCheck);
        const hidden = Math.max(0, check.findings.length - visible.length);
        return (
          <Box key={check.checkSlug} flexDirection="column" marginLeft={2}>
            <Text>
              <Text color={theme.brand}>{check.checkSlug}</Text>
              {' '}
              <Text dimColor>({count})</Text>
            </Text>

            {check.error && (
              <Text>
                {'      '}
                <Text color={theme.error}>error</Text>
                {'  '}
                {check.error}
              </Text>
            )}

            {visible.map((v, i) => {
              const lineSuffix = v.line ? `:${v.line}` : '';
              const loc = v.filePath ? `${v.filePath}${lineSuffix}` : '';
              return (
                <Box key={i} flexDirection="column">
                  <Text>
                    {'      '}
                    <Text color={v.severity === 'error' ? theme.error : theme.warning}>
                      {v.severity === 'error' ? 'error' : 'warn'}
                    </Text>
                    {'  '}
                    {v.message}
                    {loc ? ' ' : ''}
                    {loc && <Text dimColor>{loc}</Text>}
                  </Text>
                  {v.suggestion && (
                    <Text dimColor>{'            '}{v.suggestion}</Text>
                  )}
                </Box>
              );
            })}

            {hidden > 0 && (
              <Text dimColor>{'      '}… {hidden} more hidden (use <Text bold>--json</Text> or <Text bold>opensip-tools dashboard</Text> for all)</Text>
            )}

            <Text> </Text>
          </Box>
        );
      })}

      {anyTruncated && (
        <Text dimColor>
          {'  '}
          Showing first {maxViolationsPerCheck} violations per check. For the full set, run with
          {' '}<Text bold>--json</Text>{' '}or open
          {' '}<Text bold>opensip-tools dashboard</Text>.
        </Text>
      )}
    </Box>
  );
}
