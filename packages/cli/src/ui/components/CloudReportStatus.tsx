/**
 * CloudReportStatus component — renders the result of a cloud report upload.
 */

import { useTheme } from '@opensip-tools/cli-ui';
import { Text, Box } from 'ink';
import React from 'react';


export interface CloudReportStatusProps {
  readonly url: string;
  readonly findingCount: number;
  readonly runCount: number;
  readonly success: boolean;
  readonly error?: string;
  readonly chunksTotal?: number;
  readonly chunksSucceeded?: number;
}

export function CloudReportStatus({ url, findingCount, runCount, success, error, chunksTotal, chunksSucceeded }: CloudReportStatusProps): React.ReactElement {
  const theme = useTheme();
  const chunkDetail = chunksTotal != null && chunksTotal > 1
    ? ` (${chunksSucceeded}/${chunksTotal} chunks)`
    : '';

  if (!success) {
    const partial = chunksSucceeded != null && chunksSucceeded > 0;
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text>
          <Text color={partial ? theme.warning : theme.error}>{partial ? '\u26A0' : '\u2717'}</Text>
          {' '}
          {partial ? 'Partially reported' : 'Failed to report'} to <Text dimColor>{url}</Text>{chunkDetail}
        </Text>
        {error && <Text dimColor>{'    '}{error}</Text>}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>
        <Text color={theme.success}>{'\u2714'}</Text>
        {' '}
        Reported to <Text dimColor>{url}</Text>{chunkDetail}
      </Text>
      <Text dimColor>
        {'    '}
        {findingCount} findings from {runCount} checks
      </Text>
    </Box>
  );
}
