/**
 * @fileoverview JSON-safe contracts for closed SQLite integrity inspection.
 */

/** Maximum quick-check failures retained in the bounded result. */
export const SQLITE_QUICK_CHECK_MAX_ISSUES = 16;
/** Maximum foreign-key violation samples retained in the bounded result. */
export const SQLITE_FOREIGN_KEY_MAX_SAMPLES = 16;

/** Bounded sidecar observation; filesystem uncertainty is never called absent. */
export type SqliteSidecarState = 'absent' | 'present' | 'unknown';

/** Presence observed before and after the read-only SQLite connection. */
export interface SqliteSidecarPresence {
  readonly before: {
    readonly wal: SqliteSidecarState;
    readonly shm: SqliteSidecarState;
  };
  readonly after: {
    readonly wal: SqliteSidecarState;
    readonly shm: SqliteSidecarState;
  };
}

/** Bounded summary of `PRAGMA quick_check`. Native diagnostic text is omitted. */
export interface SqliteQuickCheckResult {
  readonly ok: boolean;
  readonly issueCount: number;
  readonly truncated: boolean;
}

/** Public, JSON-safe row identifier from a foreign-key violation. */
export type SqliteForeignKeyRowId = number | string | null;

/** Sanitized identity for one bounded foreign-key violation sample. */
export interface SqliteForeignKeyViolation {
  readonly table: string;
  readonly parent: string;
  readonly rowId: SqliteForeignKeyRowId;
  readonly foreignKeyIndex: number;
}

/** Bounded summary of `pragma_foreign_key_check`. */
export interface SqliteForeignKeyCheckResult {
  readonly ok: boolean;
  /**
   * Number observed by the capped query. When `truncated` is true, this is a
   * lower bound rather than an unbounded exact count.
   */
  readonly violationCount: number;
  readonly sampleCap: number;
  readonly truncated: boolean;
  readonly samples: readonly SqliteForeignKeyViolation[];
}

/** Facts available after a stable SQLite inspection completed. */
export interface SqliteIntegrityFacts {
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly userVersion: number;
  readonly supportedVersion: number;
  readonly supported: boolean;
  readonly quickCheck: SqliteQuickCheckResult;
  readonly foreignKeys: SqliteForeignKeyCheckResult;
  readonly sidecars: SqliteSidecarPresence;
}

/**
 * Stable integrity result. No branch carries native errors or handles; the
 * `native-close-failed` branch explicitly proves that native closure failed.
 */
export type SqliteIntegrityResult =
  | ({ readonly status: 'valid' } & SqliteIntegrityFacts)
  | ({
      readonly status: 'unsupported';
      readonly reason: 'schema-newer-than-cli';
    } & SqliteIntegrityFacts)
  | ({
      readonly status: 'corrupt';
      readonly reason: 'quick-check-failed' | 'foreign-key-violations';
    } & SqliteIntegrityFacts)
  | {
      readonly status: 'absent';
      readonly reason: 'file-absent';
      readonly sidecars: SqliteSidecarPresence;
    }
  | {
      readonly status: 'not-sqlite';
      readonly reason: 'invalid-sqlite-header';
      readonly sidecars: SqliteSidecarPresence;
    }
  | {
      readonly status: 'corrupt';
      readonly reason: 'sqlite-corrupt' | 'invalid-file-type';
      readonly sidecars: SqliteSidecarPresence;
    }
  | {
      readonly status: 'unreadable';
      readonly reason:
        | 'inspection-failed'
        | 'file-changed-during-inspection'
        | 'native-close-failed'
        | 'sidecar-inspection-failed';
      readonly sidecars: SqliteSidecarPresence;
    };
