/**
 * RunHeader — info header shown after the banner for each tool run. Displays
 * tool name, an optional description, metadata key-value pairs, and a
 * separator line. Used by every Ink live view + the static-render path.
 */

import { Text, Box } from 'ink';
import React from 'react';

import { useTheme } from './theme.js';

export interface RunHeaderMeta {
  readonly label: string;
  readonly value: string;
}

export interface RunHeaderProps {
  /** Title rendered in brand color, e.g. `Fitness Checks`, `Code Graph`. */
  readonly tool: string;
  /** Optional description shown below the metadata row. */
  readonly description?: string;
  /** Project root the tool is operating against. Surfaces as `Target: <cwd>`. */
  readonly cwd: string;
  /** Extra metadata pairs prepended before the cwd. */
  readonly metadata?: readonly RunHeaderMeta[];
}

export function RunHeader({ tool, description, cwd, metadata = [] }: RunHeaderProps): React.ReactElement {
  const theme = useTheme();
  const separator = '─'.repeat(60);

  const metaParts = [
    ...metadata.map((m) => `${m.label}: ${m.value}`),
    `Target: ${cwd}`,
  ];

  return (
    <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
      <Text bold color={theme.brand}>{tool}</Text>
      <Text dimColor>{metaParts.join('   ')}</Text>
      {description !== undefined && (
        <>
          <Text> </Text>
          <Text dimColor>{description}</Text>
        </>
      )}
      <Text> </Text>
      <Text dimColor>{separator}</Text>
    </Box>
  );
}
