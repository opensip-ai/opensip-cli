/**
 * RunHeader — info header shown after the banner for each tool run. Displays
 * tool name, an optional description, metadata key-value pairs, and a
 * separator line. Used by every Ink live view + the static-render path.
 *
 * Renders the `Project: <root>` line as the canonical project-location
 * marker for Ink-rendered commands. Non-Ink commands use the imperative
 * `formatProjectHeader` printed by pre-action-hook. Together these
 * cover every command path exactly once — no duplicate "Target:/Project:"
 * lines.
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
  /** Resolved project root the tool is operating against (from ctx.project.projectRoot). */
  readonly projectRoot: string;
  /** Ancestor steps walked from cwd to projectRoot; renders the "(found N levels up)" suffix when > 0. */
  readonly walkedUp?: number;
  /** Extra metadata pairs prepended before the project line. */
  readonly metadata?: readonly RunHeaderMeta[];
}

function formatProjectLine(projectRoot: string, walkedUp: number): string {
  if (walkedUp === 0) return `Project: ${projectRoot}`;
  const noun = walkedUp === 1 ? 'level' : 'levels';
  return `Project: ${projectRoot}  (found ${walkedUp} ${noun} up)`;
}

export function RunHeader({
  tool,
  description,
  projectRoot,
  walkedUp = 0,
  metadata = [],
}: RunHeaderProps): React.ReactElement {
  const theme = useTheme();
  const separator = '─'.repeat(60);

  const metaParts = [
    ...metadata.map((m) => `${m.label}: ${m.value}`),
    formatProjectLine(projectRoot, walkedUp),
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
