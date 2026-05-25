/**
 * ErrorMessage — `✗ <message>` plus an optional dim-colored suggestion line.
 * The canonical error-result render shape across every tool's live view and
 * the App.tsx static path.
 */

import { Text, Box } from 'ink';
import React from 'react';

import { useTheme } from './theme.js';

export interface ErrorMessageProps {
  readonly message: string;
  readonly suggestion?: string;
}

export function ErrorMessage({ message, suggestion }: ErrorMessageProps): React.ReactElement {
  const theme = useTheme();

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>
        <Text color={theme.error}>{'✗'}</Text>
        {' '}
        {message}
      </Text>
      {suggestion !== undefined && (
        <Text dimColor>{'    '}{suggestion}</Text>
      )}
    </Box>
  );
}
