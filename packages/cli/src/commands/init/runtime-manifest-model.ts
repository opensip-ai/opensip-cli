import { ConfigurationError } from '@opensip-cli/core';

export const RUNTIME_MANIFEST_MAX_ENTRIES = 100_000;
export const RUNTIME_MANIFEST_MAX_TOTAL_BYTES = 16 * 1024 * 1024 * 1024;
export const RUNTIME_MANIFEST_MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;
export const RUNTIME_MANIFEST_MAX_PATH_BYTES = 4096;
export const RUNTIME_MANIFEST_MAX_PATH_AGGREGATE_BYTES = 32 * 1024 * 1024;
export const RUNTIME_MANIFEST_MAX_DIGEST_BYTES = 128 * 1024 * 1024 * 1024;
/** SQLite's disposable shared-memory index is normally 32 KiB. */
export const RUNTIME_MANIFEST_MAX_SQLITE_SHM_BYTES = 1024 * 1024;
export const RUNTIME_MANIFEST_DIFF_SAMPLE_LIMIT = 16;

export type RuntimeTreePosture = 'cache-source' | 'project-runtime' | 'promotion-stage';

export type RuntimeManifestEntry =
  | {
      readonly path: string;
      readonly kind: 'directory';
      readonly mode: number;
    }
  | {
      readonly path: string;
      readonly kind: 'file';
      readonly mode: number;
      readonly sizeBytes: number;
      readonly sha256: string;
    }
  | {
      readonly path: string;
      readonly kind: 'symlink';
      readonly mode: number;
      readonly target: string;
      readonly targetSha256: string;
    };

export interface RuntimeTreeManifest {
  readonly version: 1;
  readonly rootMode: number;
  readonly sha256: string;
  readonly entryCount: number;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly symlinkCount: number;
  readonly totalBytes: number;
  readonly entries: readonly RuntimeManifestEntry[];
}

export type RuntimeManifestFailureReason =
  | 'changed'
  | 'digest-cap'
  | 'entry-cap'
  | 'hardlink'
  | 'invalid-path'
  | 'mode'
  | 'path-cap'
  | 'size-cap'
  | 'special-entry'
  | 'sqlite-absent-with-sidecar'
  | 'sqlite-invalid'
  | 'sqlite-mismatch'
  | 'sqlite-sidecar-nonempty'
  | 'sqlite-unsupported'
  | 'stage-ownership'
  | 'symlink-escape'
  | 'symlink-invalid'
  | 'unsafe-owner';

export class RuntimeManifestError extends ConfigurationError {
  constructor(readonly reason: RuntimeManifestFailureReason) {
    super(`Runtime evidence cannot be promoted safely (${reason}).`, {
      code: 'CONFIGURATION.RUNTIME_PROMOTION.MANIFEST_UNSAFE',
    });
    this.name = 'RuntimeManifestError';
  }
}
