/**
 * Inputs the host hands a tool's `scaffoldExamples` hook (ADR-0038): the
 * project's detected/selected languages (and, optionally, the scaffolded check
 * slugs). `languages` is `string[]` because core carries no language enum; the
 * CLI passes its detected list through structurally.
 */
export interface ScaffoldContext {
  readonly languages: readonly string[];
  readonly slugs?: readonly string[];
}

/**
 * One example file a tool contributes to `init` (ADR-0038). The host writes
 * `content` to `userPluginDir(tool's domain, kind)/filename`. `kind` is a plain
 * string matched against the tool's own `pluginLayout.userSubdirs` (never a
 * host-side enum of `'checks'|'recipes'|...`). `stableId` is the pinned id
 * embedded in `content` that drives stale-scaffolded detection.
 */
export interface ScaffoldFile {
  readonly kind: string;
  readonly filename: string;
  readonly content: string;
  readonly stableId: string;
}
