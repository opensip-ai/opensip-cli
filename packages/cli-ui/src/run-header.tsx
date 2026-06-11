/**
 * RunHeader — tool header shown after the banner + project line for each
 * tool run. Displays the tool name, optional metadata key-value pairs,
 * and an optional description, followed by a separator line.
 *
 * The project-location line is NOT rendered here — {@link ProjectHeader}
 * is the single canonical renderer of `ℹ Project: <root>`, mounted by the
 * App shell and each live view directly under the banner. RunHeader is
 * purely the per-tool title/metadata band.
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
  /** Metadata pairs rendered in the dim band below the title. */
  readonly metadata?: readonly RunHeaderMeta[];
}

export function RunHeader({
  tool,
  description,
  metadata = [],
}: RunHeaderProps): React.ReactElement {
  const theme = useTheme();
  const separator = '─'.repeat(60);

  return (
    <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
      <Text bold color={theme.brand}>
        {tool}
      </Text>
      {metadata.length > 0 && (
        <Text dimColor>{metadata.map((m) => `${m.label}: ${m.value}`).join('   ')}</Text>
      )}
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
