/**
 * @fileoverview Thin wrapper around `update-notifier` that checks npm
 * once a day for a newer version of @opensip-tools/cli.
 *
 * Design goals:
 *   - Silent by default when there's nothing to report.
 *   - One line of output when an update exists, printed to stderr so
 *     --json consumers aren't affected.
 *   - Opt-out via OPENSIP_NO_UPDATE (and honours the upstream
 *     NO_UPDATE_NOTIFIER flag for convention).
 *   - Non-blocking: the check runs in a child process; the current
 *     command never waits on network I/O.
 *
 * Suppressed when:
 *   - Env var OPENSIP_NO_UPDATE=1 (our flag)
 *   - Env var NO_UPDATE_NOTIFIER=1 (convention for the npm package)
 *   - Env var CI set (update-notifier suppresses by default)
 *   - stdout is not a TTY (scripts, pipelines)
 */

import updateNotifier, { type UpdateNotifier } from 'update-notifier'

export interface NotifyOptions {
  readonly name: string
  readonly version: string
  /** Override stderr writer (for tests). */
  readonly write?: (s: string) => void
}

function shouldSkip(): boolean {
  if (process.env['OPENSIP_NO_UPDATE']) return true
  if (process.env['NO_UPDATE_NOTIFIER']) return true
  // The update-notifier package already suppresses in CI and non-TTY,
  // but we short-circuit so we don't even construct the notifier —
  // keeps the startup path minimal.
  if (!process.stdout.isTTY) return true
  return false
}

/**
 * Run the update check. Returns the notifier instance (so tests can
 * assert) or null if skipped.
 */
export function maybeNotify(opts: NotifyOptions): UpdateNotifier | null {
  if (shouldSkip()) return null

  const notifier = updateNotifier({
    pkg: { name: opts.name, version: opts.version },
    // Once a day is standard and matches npm's own update nag.
    updateCheckInterval: 1000 * 60 * 60 * 24,
    shouldNotifyInNpmScript: false,
  })

  const update = notifier.update
  if (update && update.latest !== update.current) {
    const write = opts.write ?? ((s: string) => process.stderr.write(s))
    const line =
      `\nopensip-tools ${update.current} \u2192 ${update.latest} available. ` +
      `Run \`npm install -g @opensip-tools/cli\` to update.\n` +
      `(Silence with OPENSIP_NO_UPDATE=1.)\n\n`
    write(line)
  }
  return notifier
}
