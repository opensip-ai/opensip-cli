/**
 * ErrorMessage component — displays an error with an optional suggestion.
 */

import { Text, Box } from 'ink';
import React from 'react';

import { useTheme } from '../theme.js';

export interface ErrorMessageProps {
  readonly message: string;
  readonly suggestion?: string;
}

export function ErrorMessage({ message, suggestion }: ErrorMessageProps): React.ReactElement {
  const theme = useTheme();

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>
        <Text color={theme.error}>{'\u2717'}</Text>
        {' '}
        {message}
      </Text>
      {suggestion && (
        <Text dimColor>{'    '}{suggestion}</Text>
      )}
    </Box>
  );
}
