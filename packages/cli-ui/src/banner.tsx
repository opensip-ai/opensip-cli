/**
 * Banner — the OpenSIP Tools ASCII art banner. Used as the header for every
 * live-view tool runner and for App.tsx's static-render path.
 *
 * Three sizes are available via the `size` prop:
 *   - `lg` (default) — the full 8-row 3-D banner with shaded depth.
 *   - `md` — half-height. The OPENSIP wordmark is a mechanical half-block
 *     downscale of the `lg` art; the coffee cup + steam is hand-authored
 *     block art (a downscale smears away the handle-hole and saucer that
 *     make it read as a mug).
 *   - `sm` — half-height AND half-width (quarter-block wordmark, smaller mug).
 *
 * In every size OPEN is brand-coloured and SIP is bold, matching `lg`. For the
 * compact sizes the cup column and wordmark column are bottom-aligned so the
 * steam rises above the letters exactly as it does at full size.
 */

import { Text, Box } from 'ink';
import React from 'react';

import { useTheme } from './theme.js';

export type BannerSize = 'lg' | 'md' | 'sm';

// --- lg: full 3-D banner. Each entry: [cup, openPart, sipPart] ---
const BANNER_LG: readonly [string, string, string][] = [
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

/**
 * A compact (md/sm) banner. `cup` includes the steam rows and is bottom-aligned
 * with the wordmark — steam rows poke above the letters. `open`/`sip` are the
 * OPENSIP wordmark split at the OPEN│SIP boundary so each can be coloured
 * independently. `open` lines carry significant trailing spaces that position
 * the `sip` segment — do not trim them.
 */
interface CompactBanner {
  readonly cup: readonly string[];
  readonly open: readonly string[];
  readonly sip: readonly string[];
}

const BANNER_MD: CompactBanner = {
  cup: [
    ' ░    ░',
    '  ░  ░',
    '▟████████▙',
    '█████████▐▀▙',
    '█████████▐▄▟',
    '▝▀▀█████▀▀▘',
  ],
  open: [
    '██▀▀█▄▄███▀▀▀█ ██▀▀▀▀▀ ▀██  ██ ',
    '█   ██████▄▄▄█ ██▄▄▄    █▀█▄██ ',
    '█▄ ▄██████     ██       █  ▀██ ',
    '▀▀▀▀▀  ▀▀▀     ▀▀▀▀▀▀▀ ▀▀▀  ▀▀ ',
  ],
  sip: [
    '██▀▀▀█▄▄▀██▀ ██▀▀▀█▄',
    '▀██▄▄▄▄  ██  ██▄▄▄█▀',
    '▄▄▄  ███ ██  ██     ',
    ' ▀▀▀▀▀▀ ▀▀▀▀ ▀▀▀    ',
  ],
};

const BANNER_SM: CompactBanner = {
  cup: [
    ' ░  ░',
    '  ░',
    '▟████▙',
    '█████▐▌',
    '▝▀██▀▀',
  ],
  open: [
    '▗█▀▜▄▐█▀▀▙▐█▀▀▀▝█▌▐█▗',
    '█▌ ▐█▐█▄▄▛▐█▄▖  █▜▟█ ',
    '▜▙ ▟█▐█   ▐█    █ ▜█ ',
    ' ▀▀▀ ▝▀▘  ▝▀▀▀▀▝▀▘▝▀ ',
  ],
  sip: [
    '█▀▀▙▖▜█▘█▛▀▜▖',
    '▜▙▄▄ ▐█ █▙▄▟▘',
    '▄▖ █▌▐█ █▌   ',
    '▝▀▀▀ ▀▀▘▀▀   ',
  ],
};

function LargeBanner(): React.ReactElement {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      {BANNER_LG.map(([cup, openPart, sipPart], i) => (
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

function CompactBannerView({ art }: { readonly art: CompactBanner }): React.ReactElement {
  const theme = useTheme();
  return (
    <Box flexDirection="row" alignItems="flex-end">
      <Box flexDirection="column" marginRight={2}>
        {art.cup.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
      <Box flexDirection="column">
        {art.open.map((openLine, i) => (
          <Text key={i}>
            <Text color={theme.brand}>{openLine}</Text>
            <Text bold>{art.sip[i]}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}

export function Banner({ size = 'lg' }: { size?: BannerSize } = {}): React.ReactElement {
  switch (size) {
    case 'md': {
      return <CompactBannerView art={BANNER_MD} />;
    }
    case 'sm': {
      return <CompactBannerView art={BANNER_SM} />;
    }
    default: {
      return <LargeBanner />;
    }
  }
}
