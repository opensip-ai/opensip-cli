/**
 * Shared scanner exclude-arg builder for external tool adapters.
 *
 * Every per-tool exclude builder derives the same portable, project-relative
 * `.runtime` segment from the host's absolute exclude path (absolute host
 * paths no-op in most scanners' project-relative pattern matching) before
 * shaping the tool-specific flag value. This helper owns that derivation;
 * adapters supply only their flag and, when the tool needs glob decoration or
 * default-list joining, a `pattern` mapping over the derived segment.
 *
 * SECURITY: the result feeds an execFile argument ARRAY. The flag and the
 * pattern value stay distinct array elements and are never concatenated into
 * a shell string, so spaces and shell metacharacters in paths need no
 * escaping and cannot change the invoked command.
 */

/** Host-supplied exclusion input (the absolute `.runtime` artifact path). */
export interface ScannerExcludeInput {
  readonly excludePath: string;
}

/** Per-tool shaping of the shared exclude derivation. */
export interface ScannerExcludeOptions {
  /** The tool's exclude flag, e.g. `'-i'` or `'--extend-exclude'`. */
  readonly flag: string;
  /**
   * Map the derived project-relative segment to the tool's final flag value
   * (glob decoration, default-exclude joining, …). Defaults to the segment
   * itself.
   */
  readonly pattern?: (relativeSegment: string) => string;
}

/**
 * Build the `[flag, value]` exclude args from the host's exclude path.
 *
 * The derivation prefers the portable `opensip-cli/.runtime` segment; for
 * other paths it falls back to the last two path segments (or the whole
 * normalized path when no segments remain).
 */
export function buildScannerExclude(
  input: ScannerExcludeInput,
  opts: ScannerExcludeOptions,
): { readonly args: readonly string[] } {
  const normalized = input.excludePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const relativeSegment = normalized.includes('opensip-cli/.runtime')
    ? 'opensip-cli/.runtime'
    : normalized.split('/').filter(Boolean).slice(-2).join('/') || normalized;
  const value = opts.pattern === undefined ? relativeSegment : opts.pattern(relativeSegment);
  return { args: [opts.flag, value] };
}
