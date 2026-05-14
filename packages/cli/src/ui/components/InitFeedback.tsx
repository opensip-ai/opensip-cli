/**
 * InitFeedback component — renders feedback for the init command.
 */

import { Text, Box } from 'ink';
import React from 'react';

import { useTheme } from '../theme.js';

export interface InitFeedbackProps {
  readonly created: boolean;
  readonly path: string;
  readonly alreadyExists: boolean;
  readonly cwd: string;
  readonly configFilename: string;
}

export function InitFeedback({ created, path, alreadyExists, cwd, configFilename }: InitFeedbackProps): React.ReactElement {
  const theme = useTheme();

  if (alreadyExists) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text>
          <Text color={theme.warning}>{'\u26A0'}</Text>
          {' '}
          {configFilename} already exists in <Text dimColor>{cwd}</Text>
        </Text>
        <Text dimColor>{'  '}Delete it first if you want to regenerate.</Text>
      </Box>
    );
  }

  if (created) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text>
          <Text color={theme.success}>{'\u2713'}</Text>
          {' '}
          Created <Text bold>{configFilename}</Text> in <Text dimColor>{cwd}</Text>
        </Text>
        <Text> </Text>
        <Text dimColor>{'  '}This file defines which files each fitness check scans.</Text>
        <Text dimColor>{'  '}Edit the targets to match your project structure, then run:</Text>
        <Text> </Text>
        <Text>{'    '}<Text color={theme.brand}>opensip-tools fit</Text></Text>
      </Box>
    );
  }

  // Fallback: creation failed
  return (
    <Box paddingLeft={2}>
      <Text>
        <Text color={theme.error}>{'\u2717'}</Text>
        {' '}
        Failed to create {configFilename} at <Text dimColor>{path}</Text>
      </Text>
    </Box>
  );
}
