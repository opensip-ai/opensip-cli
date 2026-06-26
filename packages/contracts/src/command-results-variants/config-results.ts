/**
 * Host `opensip config` command results.
 */

/** Outcome of `opensip config validate`. */
export interface ConfigValidateResult {
  type: 'config-validate';
  readonly valid: true;
  readonly configPath: string;
  readonly namespaces: readonly string[];
  readonly warnings?: readonly string[];
}

/** Outcome of `opensip config schema`. */
export interface ConfigSchemaResult {
  type: 'config-schema';
  readonly schema: Record<string, unknown>;
  readonly namespaces: readonly string[];
  readonly outPath?: string;
}
