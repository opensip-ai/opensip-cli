/**
 * Banner — the OpenSIP Tools ASCII art banner. Used as the header for every
 * live-view tool runner and for App.tsx's static-render path.
 *
 * Four sizes are available via the `size` prop:
 *   - `lg` (default) — the full 8-row 3-D banner with shaded depth.
 *   - `md` — half-height. The OPENSIP wordmark is a mechanical half-block
 *     downscale of the `lg` art; the coffee cup + steam is hand-authored
 *     block art (a downscale smears away the handle-hole and saucer that
 *     make it read as a mug).
 *   - `sm` — half-height AND half-width (quarter-block wordmark, smaller mug).
 *   - `mini` — a compact, boxed identity card: a small amber coffee cup on
 *     the left and four info lines on the right (`opensip-tools vX.Y.Z`,
 *     the tagline, the `www.opensip.ai` URL, and the project path), framed in
 *     a rounded amber border. Modeled on the Claude Code session card. Unlike
 *     the wordmark sizes it carries the version + project path inline, so
 *     callers SUPPRESS the separate `ProjectHeader` line when `mini` is
 *     selected (the path would otherwise render twice).
 *
 * In the wordmark sizes (`lg`/`md`/`sm`) OPEN is brand-coloured and SIP is
 * bold, matching `lg`; the cup column and wordmark column are bottom-aligned
 * so the steam rises above the letters exactly as it does at full size. The
 * `mini` size colours the whole cup + frame in `theme.brand` (amber).
 */

import { Text, Box } from 'ink';
import React from 'react';

import { useTheme } from './theme.js';

export type BannerSize = 'lg' | 'md' | 'sm' | 'mini';

/** The valid banner sizes, as a runtime set for {@link normalizeBannerSize}. */
const BANNER_SIZES: ReadonlySet<string> = new Set<BannerSize>(['lg', 'md', 'sm', 'mini']);

/** Product tagline shown in the `mini` banner — mirrors the welcome screen. */
const MINI_TAGLINE = 'codebase analysis toolkit';

/** The npm command that upgrades a global install. */
const UPGRADE_COMMAND = 'npm install -g opensip-tools';

/**
 * UpdateHint — a single dim line printed UNDER the `mini` banner box when an
 * update is available, giving the actionable upgrade command. The `mini`
 * card's version-line flag (`(vX.Y.Z available)`) announces the update but
 * isn't actionable on its own; this line closes that gap without growing the
 * fixed-height box. The other banner sizes get the same command via the
 * stderr update nag, so callers render this only for `mini`.
 */
export function UpdateHint(): React.ReactElement {
  return (
    <Box paddingLeft={2}>
      <Text dimColor>↑ Update: {UPGRADE_COMMAND}</Text>
    </Box>
  );
}

/**
 * Narrow an untyped banner-size string (e.g. from `ui.banner` in
 * `opensip-tools.config.yml`, which reaches the kernel as a plain `string`)
 * to a {@link BannerSize}. Unknown / undefined values fall back to `lg`, the
 * documented default. Centralised here so `cli-ui` stays the single owner of
 * the `BannerSize` union and the layers below it (core, contracts) need only
 * pass a string.
 */
export function normalizeBannerSize(value: string | undefined): BannerSize {
  return value !== undefined && BANNER_SIZES.has(value) ? (value as BannerSize) : 'lg';
}

// --- lg: full 3-D banner. Each entry: [cup, openPart, sipPart] ---
const BANNER_LG: readonly [string, string, string][] = [
  [
    '   ░       ░             ',
    '  ██████   ████████  █████████ ████  ███',
    ' ███████   █████ ████████ ',
  ],
  [
    '    ░     ░              ',
    ' ███░░░███░███░░░░██░███░░░░░░░░███  ███',
    '███░░░░███░░███ ░███░░░░██',
  ],
  [
    '   ░       ░             ',
    '███   ░███░███   ░██░███       ░████ ███',
    '░███   ░░░ ░███ ░███   ░██',
  ],
  [
    '███████████████          ',
    '███   ░███░████████░░██████    ░██░█████',
    '░░███████  ░███ ░████████░',
  ],
  [
    '███████████████  █████   ',
    '███   ░███░███░░░░  ░███░░░    ░██ ░████',
    ' ░░░░░░███ ░███ ░███░░░░  ',
  ],
  [
    '███████████████ ░░░░███  ',
    '░███  ████░███      ░███       ░██  ░███',
    ' ███   ███ ░███ ░███      ',
  ],
  [
    '███████████████  █████   ',
    ' ░██████░  ████      █████████ ████  ███',
    '░░███████  █████ ████     ',
  ],
  [
    '░█████████████░ ░░░      ',
    '  ░░░░░░  ░░░░░     ░░░░░░░░░░░░░░  ░░░',
    ' ░░░░░░░  ░░░░░ ░░░░░     ',
  ],
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
  cup: [' ░    ░', '  ░  ░', '▟████████▙', '█████████▐▀▙', '█████████▐▄▟', '▝▀▀█████▀▀▘'],
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
  cup: [' ░  ░', '  ░', '▟████▙', '█████▐▌', '▝▀██▀▀'],
  open: [
    '▗█▀▜▄▐█▀▀▙▐█▀▀▀▝█▌▐█▗',
    '█▌ ▐█▐█▄▄▛▐█▄▖  █▜▟█ ',
    '▜▙ ▟█▐█   ▐█    █ ▜█ ',
    ' ▀▀▀ ▝▀▘  ▝▀▀▀▀▝▀▘▝▀ ',
  ],
  sip: ['█▀▀▙▖▜█▘█▛▀▜▖', '▜▙▄▄ ▐█ █▙▄▟▘', '▄▖ █▌▐█ █▌   ', '▝▀▀▀ ▀▀▘▀▀   '],
};

/**
 * `mini` cup art — four rows (steam, lid, cup body, saucer), one per info
 * line, so the steam sits beside the version line and the saucer beside the
 * project path. The cup body and saucer render in `theme.brand` (amber); the
 * steam and lid rows ({@link MINI_CUP_LIGHT_ROWS}) render in the default
 * terminal foreground so they read as white vapor + a white to-go-cup lid on
 * dark terminals and auto-contrast (rather than vanishing) on light
 * backgrounds — see {@link MiniBanner}.
 */
const BANNER_MINI_CUP: readonly string[] = [' ⋮ ⋮ ', '▟███▙', '▐███▌', ' ▀▀▀ '];

/**
 * Rows of {@link BANNER_MINI_CUP} rendered in the default foreground (no
 * `color`) rather than brand amber: the steam (row 0, white vapor) and the
 * lid (row 1, white to-go-cup lid). Default fg is ≈bright white on dark
 * terminals, an auto-contrast dark on light backgrounds, and correctly
 * colorless under `NO_COLOR`. A literal `'white'` would be invisible on light
 * terminals and would bypass the no-color theme.
 */
const MINI_CUP_LIGHT_ROWS: ReadonlySet<number> = new Set([0, 1]);

/** Marketing URL shown in the `mini` banner — brand-coloured, reads as a link. */
const MINI_URL = 'www.opensip.ai';

/**
 * The walk-up suffix shown after the project path, e.g. `(found 2 levels up)`.
 * Mirrors {@link formatProjectHeader} so `mini` carries the same discovery
 * hint the standalone `ℹ Project:` line shows for the other banner sizes —
 * `mini` suppresses that line (its box owns the path), so the suffix has to
 * live here or the hint is lost. Returns `''` when cwd IS the project root.
 */
function walkedUpSuffix(walkedUp: number | undefined): string {
  if (walkedUp === undefined || walkedUp === 0) return '';
  const noun = walkedUp === 1 ? 'level' : 'levels';
  return `  (found ${walkedUp} ${noun} up)`;
}

/**
 * MiniBanner — the boxed identity card (cup + version + tagline + path).
 *
 * Pure presentational: the version string and project path are INJECTED as
 * props. `cli-ui` has no workspace dependencies, so it cannot read the CLI
 * version (`readPackageVersion` would resolve cli-ui's own version) or the
 * project scope — the caller resolves both and passes them in.
 *
 * Info lines: name+version, tagline, marketing URL, project path. The first
 * three are always shown; `projectPath` is optional (project-agnostic
 * commands like init/configure have no project root), so the fourth line is
 * omitted while the cup keeps its four rows. `walkedUp` appends the discovery
 * hint to the path line when the project root was found above cwd. `update`,
 * when set, appends a `(vX.Y.Z available)` flag (in `theme.success`) to the
 * version line — the in-banner counterpart to the stderr update nag.
 */
function MiniBanner({
  version,
  projectPath,
  walkedUp,
  update,
}: {
  readonly version: string;
  readonly projectPath?: string;
  readonly walkedUp?: number;
  readonly update?: string;
}): React.ReactElement {
  const theme = useTheme();
  return (
    <Box borderStyle="round" borderColor={theme.brand} paddingX={1} alignSelf="flex-start">
      <Box flexDirection="column" marginRight={2}>
        {BANNER_MINI_CUP.map((line, i) => (
          // Steam + lid render in the default terminal foreground (no color) so
          // they read as white vapor and a white to-go-cup lid on dark
          // terminals and auto-contrast on light ones; the cup body and saucer
          // stay brand amber.
          <Text key={i} color={MINI_CUP_LIGHT_ROWS.has(i) ? undefined : theme.brand}>
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column">
        <Text>
          <Text bold>opensip-tools</Text> <Text dimColor>v{version}</Text>
          {update !== undefined && <Text color={theme.success}> (v{update} available)</Text>}
        </Text>
        <Text dimColor>{MINI_TAGLINE}</Text>
        <Text color={theme.brand}>{MINI_URL}</Text>
        {projectPath !== undefined && (
          <Text dimColor>
            {projectPath}
            {walkedUpSuffix(walkedUp)}
          </Text>
        )}
      </Box>
    </Box>
  );
}

function LargeBanner(): React.ReactElement {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      {BANNER_LG.map(([cup, openPart, sipPart], i) => (
        <Text key={i}>
          {cup}
          <Text color={theme.brand}>{openPart}</Text> <Text bold>{sipPart}</Text>
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

/**
 * Banner props. `version` / `projectPath` are only consumed by the `mini`
 * size (the wordmark sizes ignore them); they're optional so existing
 * `<Banner />` and `<Banner size="md" />` call sites stay valid.
 */
export interface BannerProps {
  readonly size?: BannerSize;
  /** CLI version, e.g. `2.2.1`. Rendered as `vX.Y.Z` in the `mini` card. */
  readonly version?: string;
  /** Absolute project root. Rendered as the third `mini` info line. */
  readonly projectPath?: string;
  /**
   * Ancestor steps walked from cwd to the project root. When > 0, the `mini`
   * card appends `(found N levels up)` to the path line — the discovery hint
   * the separate `ℹ Project:` line carries for the other sizes.
   */
  readonly walkedUp?: number;
  /**
   * Newer published version (e.g. `2.3.0`) when an update is available. The
   * `mini` card appends `(vX.Y.Z available)` to the version line; other sizes
   * ignore it (they rely on the stderr update nag).
   */
  readonly update?: string;
}

export function Banner({
  size = 'lg',
  version = '',
  projectPath,
  walkedUp,
  update,
}: BannerProps = {}): React.ReactElement {
  switch (size) {
    case 'md': {
      return <CompactBannerView art={BANNER_MD} />;
    }
    case 'sm': {
      return <CompactBannerView art={BANNER_SM} />;
    }
    case 'mini': {
      return (
        <MiniBanner
          version={version}
          projectPath={projectPath}
          walkedUp={walkedUp}
          update={update}
        />
      );
    }
    default: {
      return <LargeBanner />;
    }
  }
}
