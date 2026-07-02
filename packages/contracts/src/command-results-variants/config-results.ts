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

/** Outcome of `opensip config migrate`. */
export interface ConfigMigrateResult {
  type: 'config-migrate';
  readonly configPath: string;
  readonly changed: boolean;
  readonly dryRun: boolean;
  readonly check: boolean;
  readonly wrote: boolean;
  readonly fromVersion: number;
  readonly targetVersion: number;
  readonly operations: readonly {
    readonly kind: string;
    readonly fromVersion?: number;
    readonly toVersion: number;
    readonly message: string;
  }[];
}
