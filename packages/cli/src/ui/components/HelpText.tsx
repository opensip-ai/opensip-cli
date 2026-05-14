/**
 * HelpText component — minimal help placeholder.
 *
 * Commander auto-generates detailed help output, so this component is a
 * lightweight placeholder that can be extended later if needed.
 */

import { Text, Box } from 'ink';
import React from 'react';

import { useTheme } from '../theme.js';

export function HelpText(): React.ReactElement {
  const theme = useTheme();

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text bold>opensip-tools</Text>
      <Text dimColor>Codebase analysis toolkit</Text>
      <Text> </Text>
      <Text>
        <Text bold>Commands:</Text>
      </Text>
      <Text>  <Text color={theme.brand}>fit</Text>     Run fitness checks</Text>
      <Text>  <Text color={theme.brand}>init</Text>    Generate config file</Text>
      <Text>  <Text color={theme.brand}>sim</Text>     Run simulation scenarios [experimental]</Text>
      <Text>  <Text color={theme.brand}>plugin</Text>  Manage plugins</Text>
      <Text> </Text>
      <Text dimColor>Run opensip-tools {'<command>'} --help for details.</Text>
    </Box>
  );
}
