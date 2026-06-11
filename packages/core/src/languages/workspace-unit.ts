/**
 * A unit of fan-out for `--workspace` mode. Each language adapter that
 * implements `discoverWorkspaceUnits` returns these — one per package,
 * Cargo workspace member, Python sub-project, etc.
 *
 * Shape is intentionally minimal: identity (`id`), where to anchor the
 * child run (`rootDir`), and the marker file the adapter used to find
 * it (`configPath`) for adapters that have one.
 */
export interface WorkspaceUnit {
  /** Stable, human-readable id (e.g. `@opensip-tools/core`, `crate-foo`). */
  readonly id: string;
  /** Absolute path to the unit's root directory. */
  readonly rootDir: string;
  /** Adapter-specific marker file (tsconfig.json, Cargo.toml, etc.), if any. */
  readonly configPath?: string;
}
