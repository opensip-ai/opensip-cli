/**
 * host-config-flag — the canonical `--config` flag the host guarantees on every
 * tool primary.
 *
 * `--config` is NOT an ADR-0021 `commonFlags` registry entry: it is a HOST flag,
 * read by the pre-action hook as `opts.config` (the explicit
 * `opensip-cli.config.yml` path that overrides the package.json pointer and the
 * default discovery). Fitness historically declared its own `--config`
 * OptionSpec; the host decorator (`decorateToolPrimary`) now guarantees the SAME
 * flag on graph / sim / any third-party primary that did not declare it, so the
 * targeting-config override is uniform across tools.
 *
 * The definition lives here (host-owned) so the decorator and any future host
 * surface read one source of truth. Fitness's in-spec `--config` is byte-matched
 * to this text; the decorator is idempotent and skips it where already present.
 */
export const CONFIG_FLAG = {
  flags: '--config <path>',
  description: 'Path to opensip-cli.config.yml (overrides package.json pointer and default)',
} as const;
