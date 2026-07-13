/**
 * Host-reserved root command names (ADR-0159).
 *
 * Every host-owned root command (visible or internal) plus Commander's
 * implicit `help`. A Tool whose command specs claim one of these as a root
 * name, root alias, or `parent` is rejected at admission by
 * `rejectHostCommandCollisions` — before Commander mounting, so the host
 * surface can never be shadowed or double-mounted.
 *
 * This list is static so the admission gate needs no mounted program; the
 * parity test in `__tests__/reject-host-command-collisions.test.ts` asserts it
 * equals the actually-mounted host surface (names + aliases), so adding or
 * renaming a host command without updating this list fails CI.
 */
export const HOST_RESERVED_ROOT_COMMANDS: ReadonlySet<string> = new Set([
  '__capability-pack-worker',
  '__tool-command-worker',
  'agent-catalog',
  'audit',
  'completion',
  'config',
  'configure',
  'help',
  'init',
  'policy',
  'repair',
  'report',
  'sessions',
  'suite',
  'tools',
  'uninstall',
]);
