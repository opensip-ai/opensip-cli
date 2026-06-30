/**
 * App — top-level Ink shell. Renders the banner + project line, then the
 * result body via the shared view-model (`resultToView` → `renderToInk`).
 *
 * There is no per-result-type rendering here anymore: every CommandResult
 * is expressed once as a ViewNode by `resultToView`, and the same node is
 * rendered to plain text on the non-TTY path (bootstrap/render.ts). This
 * shell owns only the chrome the plain-text path intentionally omits — the
 * banner and the `ℹ Project:` line.
 */

import { Banner, UpdateHint, normalizeBannerSize, renderToInk } from '@opensip-cli/cli-ui';
import { Box } from 'ink';
import React from 'react';

import { resultToView } from './result-to-view.js';

import type { CommandResult } from '@opensip-cli/contracts';
import type { UiContext } from '@opensip-cli/core';

/** Project location for the shell's `ℹ Project:` line. */
export interface ProjectHeaderProps {
  readonly root: string;
  readonly walkedUp: number;
}

export interface AppProps {
  readonly result: CommandResult;
  /** Omitted for project-agnostic commands (init/configure/completion) and scopeless error paths. */
  readonly projectHeader?: ProjectHeaderProps;
  /** Presentation settings (banner size + version). Omitted on scopeless paths. */
  readonly ui?: UiContext;
}

/**
 * Result types that render WITHOUT the banner. `error` stays terse — a
 * bare `✗` line reads better in CI logs and above a stack of error text.
 * `--json` and `completion` never reach this component (they bypass the
 * Ink render seam entirely), so they need no entry here.
 */
const BANNERLESS_RESULT_TYPES: ReadonlySet<CommandResult['type']> = new Set(['error']);

/**
 * App shell — the single source of truth for banner visibility. Renders
 * the banner once for every human-facing command, then the result body
 * through the shared view-model.
 */
export function App({ result, projectHeader, ui }: AppProps): React.ReactElement {
  const showBanner = !BANNERLESS_RESULT_TYPES.has(result.type);
  const bannerSize = normalizeBannerSize(ui?.bannerSize);
  return (
    <Box flexDirection="column">
      {showBanner && (
        <Banner
          size={bannerSize}
          version={ui?.version}
          projectPath={projectHeader?.root}
          walkedUp={projectHeader?.walkedUp}
          update={ui?.update}
        />
      )}
      {showBanner && ui?.update !== undefined && <UpdateHint />}
      {renderToInk(resultToView(result))}
    </Box>
  );
}
