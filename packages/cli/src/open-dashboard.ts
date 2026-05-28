/**
 * @fileoverview Helper for the `--open` flag on `fit` and `sim`.
 *
 * After a run completes, generate the HTML dashboard and launch it in
 * the default browser. Hard-skip conditions are strict: we NEVER open
 * a browser in environments where it would be wrong (CI, non-TTY,
 * --json output, SSH without a display).
 *
 * The underlying cross-platform launcher is the `open` npm package
 * (wraps macOS `open`, Linux `xdg-open`, Windows `start`).
 */

import open from 'open'

export interface OpenDashboardDecision {
  readonly shouldOpen: boolean
  readonly reason: string
}

export interface OpenDashboardContext {
  readonly openRequested: boolean
  readonly jsonOutput: boolean
  readonly stdoutIsTTY: boolean
  readonly env: NodeJS.ProcessEnv
}

/**
 * Decide whether to honor a --open request. Kept pure so tests can
 * exercise every branch without process manipulation.
 *
 * Skip conditions (all strict — no override):
 *   - --json set (caller wants machine output)
 *   - stdout is not a TTY (pipeline / log redirect)
 *   - CI env var set (GitHub Actions, GitLab CI, CircleCI, etc.)
 *   - SSH_CONNECTION set AND no DISPLAY/WAYLAND_DISPLAY (remote shell
 *     without a graphical session — don't try)
 */
export function decideOpen(ctx: OpenDashboardContext): OpenDashboardDecision {
  if (!ctx.openRequested) return { shouldOpen: false, reason: 'not-requested' }
  if (ctx.jsonOutput) return { shouldOpen: false, reason: 'json-mode' }
  if (!ctx.stdoutIsTTY) return { shouldOpen: false, reason: 'non-tty' }
  if (ctx.env.CI) return { shouldOpen: false, reason: 'ci-env' }
  const ssh = ctx.env.SSH_CONNECTION ?? ctx.env.SSH_CLIENT
  const display = ctx.env.DISPLAY ?? ctx.env.WAYLAND_DISPLAY
  if (ssh && !display) return { shouldOpen: false, reason: 'ssh-no-display' }
  return { shouldOpen: true, reason: 'ok' }
}

/**
 * Launch the given URL or file path in the default browser. Returns
 * true on success, false if `open` refused or threw. Never propagates
 * — a failure to open a browser should NOT fail the fitness run.
 */
export async function launchBrowser(target: string): Promise<boolean> {
  try {
    await open(target)
    return true
  } catch {
    // @fitness-ignore-next-line error-handling-quality -- documented contract (see JSDoc above): failure to open a browser must NOT fail the fitness run; caller dispatches on the boolean return.
    return false
  }
}
