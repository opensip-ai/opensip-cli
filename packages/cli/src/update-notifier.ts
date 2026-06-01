/**
 * @fileoverview Thin wrapper around `update-notifier` that checks npm
 * once a day for a newer version of @opensip-tools/cli.
 *
 * Two consumers, one cached check:
 *   - {@link checkForUpdate} returns the newer version string (if any) so
 *     the `mini` banner can surface it inline as `(vX.Y.Z available)`.
 *   - {@link formatUpdateNag} builds the stderr one-liner shown for the
 *     other banner sizes (which have no version line to annotate).
 * Both read the SAME once-a-day cached result `update-notifier` maintains;
 * the bootstrap calls `checkForUpdate` once and decides which surface to use.
 *
 * Design goals:
 *   - Silent by default when there's nothing to report.
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

export interface CheckForUpdateOptions {
  readonly name: string
  readonly version: string
}

/** Split `2.2.1-beta.1` into `([2,2,1], 'beta.1')`; missing parts → 0 / ''. */
function splitPrerelease(version: string): [readonly number[], string] {
  const [core, ...rest] = version.split('-')
  const nums = core.split('.').map((p) => Number.parseInt(p, 10) || 0)
  return [nums, rest.join('-')]
}

/**
 * Strict semver "is `latest` newer than `current`". Compares the numeric
 * MAJOR.MINOR.PATCH core; with equal cores a prerelease (`2.2.1-beta`) is
 * treated as OLDER than its release (`2.2.1`), per semver.
 *
 * This is the guard the nag relies on: the previous `latest !== current`
 * check fired on ANY difference, so running a build AHEAD of npm's `latest`
 * (a local dev build, or a prerelease) wrongly prompted a "downgrade". We
 * only notify when there is a genuinely newer release to move TO.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const [latestCore, latestPre] = splitPrerelease(latest)
  const [currentCore, currentPre] = splitPrerelease(current)
  for (let i = 0; i < 3; i++) {
    const l = latestCore[i] ?? 0
    const c = currentCore[i] ?? 0
    if (l > c) return true
    if (l < c) return false
  }
  // Cores equal: a full release is newer than a prerelease of the same core.
  return latestPre === '' && currentPre !== ''
}

function shouldSkip(): boolean {
  if (process.env.OPENSIP_NO_UPDATE) return true
  if (process.env.NO_UPDATE_NOTIFIER) return true
  // The update-notifier package already suppresses in CI and non-TTY,
  // but we short-circuit so we don't even construct the notifier —
  // keeps the startup path minimal.
  if (!process.stdout.isTTY) return true
  return false
}

/**
 * Check for a newer published version, scheduling the once-a-day background
 * fetch as a side effect. Returns the newer version string (e.g. `2.3.0`)
 * when npm's `latest` is genuinely newer than what's running, or `undefined`
 * when up-to-date, opted-out, non-TTY, or the cached check hasn't completed.
 *
 * Never throws: a malformed cache or notifier failure degrades to "no update
 * known" rather than breaking the command. Callers decide how to surface it
 * (the `mini` banner inline, or {@link formatUpdateNag} on stderr).
 */
export function checkForUpdate(opts: CheckForUpdateOptions): string | undefined {
  if (shouldSkip()) return undefined
  try {
    const notifier = updateNotifier({
      pkg: { name: opts.name, version: opts.version },
      updateCheckInterval: 1000 * 60 * 60 * 24,
      shouldNotifyInNpmScript: false,
    })
    const update = notifier.update
    if (update && isNewerVersion(update.latest, update.current)) {
      return update.latest
    }
  } catch {
    // @fitness-ignore-next-line error-handling-quality -- the update check is best-effort cosmetic: any failure (corrupt cache, network helper error) must degrade silently to "no update known", never break the user's command.
    return undefined
  }
  return undefined
}

/**
 * Build the stderr update-nag line for the non-`mini` banner sizes (which
 * have no version line to annotate inline) and the banner-less `--json` path.
 * The `mini` banner surfaces the same information in-box, so the bootstrap
 * skips this for `mini`.
 */
export function formatUpdateNag(current: string, latest: string): string {
  return (
    `\nopensip-tools ${current} → ${latest} available. ` +
    `Run \`npm install -g @opensip-tools/cli\` to update.\n` +
    `(Silence with OPENSIP_NO_UPDATE=1.)\n\n`
  )
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
  // Only nag when npm's latest is genuinely NEWER than what's running — not
  // merely different. Guards against the "2.2.1 → 2.1.0 available" downgrade
  // prompt seen when running a build ahead of the published `latest` tag.
  if (update && isNewerVersion(update.latest, update.current)) {
    const write = opts.write ?? ((s: string) => process.stderr.write(s))
    const line =
      `\nopensip-tools ${update.current} \u2192 ${update.latest} available. ` +
      `Run \`npm install -g @opensip-tools/cli\` to update.\n` +
      `(Silence with OPENSIP_NO_UPDATE=1.)\n\n`
    write(line)
  }
  return notifier
}
