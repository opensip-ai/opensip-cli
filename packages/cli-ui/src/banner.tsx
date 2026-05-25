/**
 * Banner — the OpenSIP Tools ASCII art banner. Used as the header for every
 * live-view tool runner and for App.tsx's static-render path.
 */

import { Text, Box } from 'ink';
import React from 'react';

import { useTheme } from './theme.js';

// Each entry: [cup, openPart, sipPart]
const BANNER: readonly [string, string, string][] = [
  ['   ░       ░             ',  '  ██████   ████████  █████████ ████  ███', ' ███████   █████ ████████ '],
  ['    ░     ░              ',  ' ███░░░███░███░░░░██░███░░░░░░░░███  ███', '███░░░░███░░███ ░███░░░░██'],
  ['   ░       ░             ',  '███   ░███░███   ░██░███       ░████ ███', '░███   ░░░ ░███ ░███   ░██'],
  ['███████████████          ',  '███   ░███░████████░░██████    ░██░█████', '░░███████  ░███ ░████████░'],
  ['███████████████  █████   ',  '███   ░███░███░░░░  ░███░░░    ░██ ░████', ' ░░░░░░███ ░███ ░███░░░░  '],
  ['███████████████ ░░░░███  ',  '░███  ████░███      ░███       ░██  ░███', ' ███   ███ ░███ ░███      '],
  ['███████████████  █████   ',  ' ░██████░  ████      █████████ ████  ███', '░░███████  █████ ████     '],
  ['░█████████████░ ░░░      ',  '  ░░░░░░  ░░░░░     ░░░░░░░░░░░░░░  ░░░', ' ░░░░░░░  ░░░░░ ░░░░░     '],
];

const BANNER_SAUCER = ' ░███████████░';

export function Banner(): React.ReactElement {
  const theme = useTheme();

  return (
    <Box flexDirection="column">
      {BANNER.map(([cup, openPart, sipPart], i) => (
        <Text key={i}>
          {cup}
          <Text color={theme.brand}>{openPart}</Text>
          {' '}
          <Text bold>{sipPart}</Text>
        </Text>
      ))}
      <Text>{BANNER_SAUCER}</Text>
    </Box>
  );
}
