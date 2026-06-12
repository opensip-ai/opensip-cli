/**
 * Tier A storage-contract static checks (ADR-0042).
 *
 * The enforceable-now tier of the tool storage contract: a tool package must
 * not carry schema-mutation capability against the host-owned SQLite store —
 * no DDL, no migration runners, no direct datastore-file paths, no imports of
 * the datastore package's private schema/migration modules. Scans the staged
 * package's OWN source files (not its node_modules) with string patterns;
 * a guardrail, not the only lock — the stronger guarantee is that the Tool
 * runtime context never exposes raw schema-mutation capabilities.
 *
 * Pattern-family note: the DDL list deliberately mirrors the
 * `restrict-raw-db-access` fitness check's vocabulary (checks-universal,
 * `src/checks/architecture/restrict-raw-db-access.ts`). The two lists are kept
 * from drifting by a parity test (`tools-validate.test.ts`), NOT by a cli →
 * check-pack production import (which would couple the host to a tool's pack).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** One Tier A violation: where, what matched, and which contract clause. */
export interface StorageFinding {
  /** Path relative to the scanned package dir. */
  readonly file: string;
  /** 1-based line of the first match. */
  readonly line: number;
  readonly matched: string;
  readonly clause: string;
}

/** The Tier A pattern families (exported for the drift-parity test). */
export const TIER_A_PATTERNS: readonly { readonly pattern: RegExp; readonly clause: string }[] = [
  {
    pattern: /\b(CREATE|ALTER|DROP)\s+TABLE\b/i,
    clause: 'no DDL against the OpenSIP datastore (ADR-0042 Tier A)',
  },
  {
    pattern: /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i,
    clause: 'no DDL against the OpenSIP datastore (ADR-0042 Tier A)',
  },
  {
    pattern: /\bPRAGMA\s+writable_schema\b/i,
    clause: 'no schema-mutation pragmas (ADR-0042 Tier A)',
  },
  {
    pattern: /\.runtime\/datastore\.sqlite/,
    clause: 'no direct datastore-file access (ADR-0042 Tier A)',
  },
  {
    pattern: /@opensip-tools\/datastore\/(schema|migrations)\//,
    clause: 'no datastore-private schema/migration imports (ADR-0042 Tier A)',
  },
  {
    pattern: /drizzle-orm\/[\w/-]*migrator/,
    clause: 'no migration runners against the OpenSIP datastore (ADR-0042 Tier A)',
  },
];

const SCANNED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);

function* walkSourceFiles(dir: string, root: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      yield* walkSourceFiles(abs, root);
      continue;
    }
    const dot = entry.lastIndexOf('.');
    if (dot !== -1 && SCANNED_EXTENSIONS.has(entry.slice(dot))) yield abs;
  }
}

/**
 * Scan one staged package dir for Tier A storage-contract violations.
 * Returns findings (empty = section passes). Pure file reads; runs no code.
 */
export function runStorageContractChecks(stagedDir: string): readonly StorageFinding[] {
  const findings: StorageFinding[] = [];
  for (const file of walkSourceFiles(stagedDir, stagedDir)) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    for (const { pattern, clause } of TIER_A_PATTERNS) {
      if (!pattern.test(content)) continue;
      const lineIdx = lines.findIndex((l) => pattern.test(l));
      findings.push({
        file: relative(stagedDir, file),
        line: lineIdx === -1 ? 1 : lineIdx + 1,
        matched: pattern.source,
        clause,
      });
    }
  }
  return findings;
}
