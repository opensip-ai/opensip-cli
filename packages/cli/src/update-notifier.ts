/**
 * @fileoverview Thin wrapper around `update-notifier` that checks npm
 * hourly for a newer version of opensip-cli (see UPDATE_CHECK_INTERVAL_MS).
 *
 * `update-notifier` is used purely as the *fetcher* — it runs the throttled
 * (hourly), detached, non-blocking network check. It is NOT used as the
 * display source, because its `check()` deletes the cached result the instant
 * it's read, which would make the notice show at most once per fetch cycle.
 * Instead the newest known version is mirrored into a sticky store
 * (`update-state.ts`) that {@link checkForUpdate} consults on EVERY run, so
 * the notice persists until the running version catches up. See
 * `update-state.ts` for the rationale in full.
 *
 * Two consumers, one resolved result:
 *   - {@link checkForUpdate} returns the newer version string (if any) so
 *     the `mini` banner can surface it inline as `(vX.Y.Z available)`.
 *   - {@link formatUpdateNag} builds the stderr one-liner shown for the
 *     other banner sizes (which have no version line to annotate).
 * The bootstrap calls `checkForUpdate` once and decides which surface to use.
 *
 * Design goals:
 *   - Silent by default when there's nothing to report.
 *   - Persistent while a genuinely newer release exists; self-clearing the
 *     run after the user upgrades.
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

import updateNotifier, { type UpdateNotifier } from 'update-notifier';

import { hostEnv } from './env/host-env-specs.js';
import { clearKnownLatest, readKnownLatest, writeKnownLatest } from './update-state.js';

/**
 * How often the detached background fetch may hit npm to learn the latest
 * published version. `update-notifier` throttles its network check to this
 * interval; the sticky store (`update-state.ts`) then drives *display* on
 * every run. This is therefore the worst-case DETECTION latency: a freshly
 * published release becomes visible within one interval of going live (on the
 * run after the next fetch completes — the fetch is detached, so never the
 * same run).
 *
 * Set to 1 hour rather than the conventional 24h: the fetch is non-blocking,
 * so a shorter interval costs the user nothing at the command line and only a
 * modest amount of extra npm traffic (≤1 request/hour/user), while shrinking
 * the "I published but the CLI still says up-to-date" window from a day to an
 * hour. One named constant so the two call sites can't drift.
 */
export const UPDATE_CHECK_INTERVAL_MS = 1000 * 60 * 60;

export interface NotifyOptions {
  readonly name: string;
  readonly version: string;
  /** Override stderr writer (for tests). */
  readonly write?: (s: string) => void;
}

export interface CheckForUpdateOptions {
  readonly name: string;
  readonly version: string;
  /**
   * Override the sticky update-state file path (for tests). Defaults to
   * `~/.opensip-cli/update-state.json`.
   */
  readonly stateFile?: string;
}

/** Split `2.2.1-beta.1` into `([2,2,1], 'beta.1')`; missing parts → 0 / ''. */
function splitPrerelease(version: string): [readonly number[], string] {
  const [core, ...rest] = version.split('-');
  const nums = core.split('.').map((p) => Number.parseInt(p, 10) || 0);
  return [nums, rest.join('-')];
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
  const [latestCore, latestPre] = splitPrerelease(latest);
  const [currentCore, currentPre] = splitPrerelease(current);
  for (let i = 0; i < 3; i++) {
    const l = latestCore[i] ?? 0;
    const c = currentCore[i] ?? 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  // Cores equal: a full release is newer than a prerelease of the same core.
  return latestPre === '' && currentPre !== '';
}

function shouldSkip(): boolean {
  // Either opt-out (read through the registry) skips the check — byte-identical
  // to the prior two independent truthy `process.env` checks.
  if (hostEnv.get<boolean>('OPENSIP_NO_UPDATE') === true) return true;
  if (hostEnv.get<boolean>('NO_UPDATE_NOTIFIER') === true) return true;
  // The update-notifier package already suppresses in CI and non-TTY,
  // but we short-circuit so we don't even construct the notifier —
  // keeps the startup path minimal.
  if (!process.stdout.isTTY) return true;
  return false;
}

/**
 * Resolve whether a newer published version is available, scheduling the
 * hourly background fetch as a side effect. Returns the newer version
 * string (e.g. `2.3.0`) when one is known, or `undefined` when up-to-date,
 * opted-out, or non-TTY.
 *
 * Unlike `update-notifier`'s own delete-on-read result, this is **sticky**:
 * the newest version the hourly check observes is mirrored into a small store
 * (`update-state.ts`) that is read on EVERY run, so the notice persists until
 * the running version catches up — at which point the store is cleared and
 * the notice stops on its own.
 *
 * Never throws: a malformed cache or notifier failure degrades to "no update
 * known" rather than breaking the command. Callers decide how to surface it
 * (the `mini` banner inline, or {@link formatUpdateNag} on stderr).
 */
export function checkForUpdate(opts: CheckForUpdateOptions): string | undefined {
  if (shouldSkip()) return undefined;
  try {
    // Fetcher: schedules the throttled, detached hourly network check. On the
    // run right after that check completes, `notifier.update` is populated
    // (then update-notifier deletes it from its own cache — hence the mirror).
    const notifier = updateNotifier({
      pkg: { name: opts.name, version: opts.version },
      updateCheckInterval: UPDATE_CHECK_INTERVAL_MS,
      shouldNotifyInNpmScript: false,
    });
    const fresh = notifier.update;
    if (fresh && isNewerVersion(fresh.latest, fresh.current)) {
      writeKnownLatest(fresh.latest, opts.stateFile);
    }
    // @fitness-ignore-next-line error-handling-quality -- the update fetch is best-effort cosmetic: any failure (corrupt cache, network helper error) must degrade silently, never break the user's command. The sticky store below still drives display from whatever was last known.
  } catch {
    // Intentionally swallow — see the directive above. Display falls through
    // to readKnownLatest, so a failed fetch just shows the last known state.
  }

  // Display: driven entirely by the sticky store so the notice persists across
  // runs. Clear it once the running version has caught up so it self-stops
  // after an upgrade.
  const known = readKnownLatest(opts.stateFile);
  if (known && isNewerVersion(known, opts.version)) {
    return known;
  }
  if (known) {
    clearKnownLatest(opts.stateFile);
  }
  return undefined;
}

/**
 * Build the stderr update-nag line for the non-`mini` banner sizes (which
 * have no version line to annotate inline) and the banner-less `--json` path.
 * The `mini` banner surfaces the same information in-box, so the bootstrap
 * skips this for `mini`.
 */
export function formatUpdateNag(current: string, latest: string): string {
  return (
    `\nOpenSIP CLI ${current} -> ${latest} available. ` +
    `Run \`curl -fsSL https://opensip.ai/cli/install.sh | bash\` to update.\n` +
    `(Silence with OPENSIP_NO_UPDATE=1.)\n\n`
  );
}

/**
 * Run the update check. Returns the notifier instance (so tests can
 * assert) or null if skipped.
 */
export function maybeNotify(opts: NotifyOptions): UpdateNotifier | null {
  if (shouldSkip()) return null;

  const notifier = updateNotifier({
    pkg: { name: opts.name, version: opts.version },
    // Hourly (UPDATE_CHECK_INTERVAL_MS) — the detached fetch never blocks the
    // command, so we trade a little npm traffic for sub-hourly detection.
    updateCheckInterval: UPDATE_CHECK_INTERVAL_MS,
    shouldNotifyInNpmScript: false,
  });

  const update = notifier.update;
  // Only nag when npm's latest is genuinely NEWER than what's running — not
  // merely different. Guards against the "2.2.1 → 2.1.0 available" downgrade
  // prompt seen when running a build ahead of the published `latest` tag.
  if (update && isNewerVersion(update.latest, update.current)) {
    const write = opts.write ?? ((s: string) => process.stderr.write(s));
    const line =
      `\nOpenSIP CLI ${update.current} -> ${update.latest} available. ` +
      `Run \`curl -fsSL https://opensip.ai/cli/install.sh | bash\` to update.\n` +
      `(Silence with OPENSIP_NO_UPDATE=1.)\n\n`;
    write(line);
  }
  return notifier;
}
