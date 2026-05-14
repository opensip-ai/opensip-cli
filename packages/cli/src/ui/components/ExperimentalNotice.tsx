/**
 * ExperimentalNotice component — renders the "under development" notice
 * for the sim command.
 */

import { Text, Box } from 'ink';
import React from 'react';

import { useTheme } from '../theme.js';

export interface ExperimentalNoticeProps {
  readonly tool: 'sim';
  readonly cwd: string;
}

export function ExperimentalNotice({ tool: _tool, cwd: _cwd }: ExperimentalNoticeProps): React.ReactElement {
  const theme = useTheme();

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text> </Text>
      <Text>
        <Text color={theme.warning}>Status:</Text>
        {' '}Under active development — not yet available for use.
      </Text>
      <Text>  We're looking for contributors to help build this out!</Text>
      <Text> </Text>
      <Text dimColor>  {'\u2192'} https://github.com/opensip-ai/opensip-tools/issues</Text>
    </Box>
  );
}
