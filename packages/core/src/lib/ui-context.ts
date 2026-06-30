/**
 * @fileoverview UiContext — per-invocation presentation settings.
 *
 * A small kernel-level bag for values the render paths need but that aren't
 * owned by any single tool: the selected banner size and the CLI version.
 * Populated once by the CLI bootstrap (pre-action hook) and read by every
 * render seam — the static `App`, fit's live view, and graph's live view —
 * via `currentScope()?.ui`.
 *
 * `bannerSize` is a plain `string` here, NOT the `BannerSize` union: that
 * union lives in `@opensip-cli/cli-ui` (a higher layer the kernel must not
 * import). The render sites narrow it with `normalizeBannerSize` at the
 * point of use, so an unknown / stale config value degrades to `mini`.
 */

/** Per-invocation presentation settings, read by the render paths. */
export interface UiContext {
  /**
   * Selected banner art. Only `mini` is supported (product default
   * `mini`, applied by the CLI bootstrap when no `cli.ui.banner` is set);
   * retained as a string for kernel/UI layer separation.
   * Stored untyped; narrowed via cli-ui's `normalizeBannerSize` at render.
   */
  readonly bannerSize: string;
  /** CLI version (e.g. `1.0.0`), shown by the `mini` banner. */
  readonly version: string;
  /**
   * Newer published version available on npm (e.g. `1.0.1`), or `undefined`
   * when up-to-date / the check is skipped or hasn't completed. Resolved by
   * the CLI bootstrap from the cached `update-notifier` result. The `mini`
   * banner surfaces it inline as `(<new-version> available)`; bannerless JSON
   * output relies on the separate stderr nag.
   */
  readonly update?: string;
}
