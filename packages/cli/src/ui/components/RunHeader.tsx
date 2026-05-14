/**
 * RunHeader — shared info header shown after the banner for each tool run.
 * Displays tool name, metadata key-value pairs, description, and separator.
 */

import { Text, Box } from 'ink';
import React from 'react';

import { useTheme } from '../theme.js';

export interface RunHeaderMeta {
  readonly label: string;
  readonly value: string;
}

export interface RunHeaderProps {
  readonly tool: string;
  readonly description: string;
  readonly cwd: string;
  readonly metadata?: readonly RunHeaderMeta[];
}

export function RunHeader({ tool, description, cwd, metadata = [] }: RunHeaderProps): React.ReactElement {
  const theme = useTheme();
  const separator = '\u2500'.repeat(60);

  // Build the metadata line: "Recipe: default   Checks: 124   Target: /path"
  const metaParts = [
    ...metadata.map(m => `${m.label}: ${m.value}`),
    `Target: ${cwd}`,
  ];

  return (
    <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
      <Text bold color={theme.brand}>{tool}</Text>
      <Text dimColor>{metaParts.join('   ')}</Text>
      <Text> </Text>
      <Text dimColor>{description}</Text>
      <Text> </Text>
      <Text dimColor>{separator}</Text>
    </Box>
  );
}
