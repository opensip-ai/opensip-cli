/**
 * Banner — the OpenSIP CLI ASCII art banner. Used as the header for every
 * live-view tool runner and for App.tsx's static-render path.
 *
 * The coffee cup is the canonical logo mark (ADR-0102), so the banner is the
 * compact boxed identity card: a small amber coffee cup on the left and four
 * info lines on the right (`opensip-cli v1.0.0`, the tagline, the
 * `www.opensip.ai` URL, and the project path), framed in a rounded amber
 * border.
 */

import { Text, Box } from 'ink';
import React from 'react';

import { useTheme } from './theme.js';

export type BannerSize = 'mini';

/** The valid banner size, as a runtime set for {@link normalizeBannerSize}. */
const BANNER_SIZES: ReadonlySet<string> = new Set<BannerSize>(['mini']);

/** Product tagline shown in the `mini` banner — mirrors the welcome screen. */
const MINI_TAGLINE = 'codebase intelligence from your terminal';

/** The command that installs/upgrades the CLI via the hosted install script. */
const UPGRADE_COMMAND = 'curl -fsSL https://opensip.ai/cli/install.sh | bash';

/**
 * UpdateHint — a single dim line printed UNDER the banner box when an update is
 * available, giving the actionable upgrade command. The banner's version-line
 * flag (`(<new-version> available)`) announces the update but isn't actionable
 * on its own; this line closes that gap without growing the fixed-height box.
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
 * `opensip-cli.config.yml`, which reaches the kernel as a plain `string`)
 * to a {@link BannerSize}. Unknown / undefined values fall back to `mini`, the
 * only supported banner size. Centralised here so `cli-ui` stays the single
 * owner of the `BannerSize` union and the layers below it (core, contracts)
 * need only pass a string.
 */
export function normalizeBannerSize(value: string | undefined): BannerSize {
  return value !== undefined && BANNER_SIZES.has(value) ? (value as BannerSize) : 'mini';
}

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
 * Mirrors {@link formatProjectHeader} so the banner carries the same discovery
 * hint the plain-text `ℹ Project:` line shows. Returns `''` when cwd IS the
 * project root.
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
 * when set, appends a `(<new-version> available)` flag (in `theme.success`) to the
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
          <Text bold>OpenSIP CLI</Text> <Text dimColor>v{version}</Text>
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

/**
 * Banner props. `version` / `projectPath` are optional so existing `<Banner />`
 * call sites stay valid.
 */
export interface BannerProps {
  readonly size?: BannerSize;
  /** CLI version, e.g. `1.0.0`. Rendered as `v<version>` in the `mini` card. */
  readonly version?: string;
  /** Absolute project root. Rendered as the third `mini` info line. */
  readonly projectPath?: string;
  /**
   * Ancestor steps walked from cwd to the project root. When > 0, the `mini`
   * card appends `(found N levels up)` to the path line.
   */
  readonly walkedUp?: number;
  /**
   * Newer published version (e.g. `1.0.1`) when an update is available. The
   * banner appends `(<new-version> available)` to the version line.
   */
  readonly update?: string;
}

export function Banner({
  size = 'mini',
  version = '',
  projectPath,
  walkedUp,
  update,
}: BannerProps = {}): React.ReactElement {
  normalizeBannerSize(size);
  return (
    <MiniBanner version={version} projectPath={projectPath} walkedUp={walkedUp} update={update} />
  );
}
