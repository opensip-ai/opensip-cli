import { requireDrizzleHandle } from '@opensip-cli/datastore/internal';

import { SessionMaintenanceRepo } from './session-maintenance-repo.js';
import { SessionReadRepo, type SessionListOptions } from './session-read-repo.js';
import { SessionWriteRepo } from './session-write-repo.js';

import type { StoredSession, StoredSessionHostMetrics } from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';



/**
 * Persistence layer for tool-run sessions. Stores generic session columns plus
 * one opaque per-tool `payload` blob; holds ZERO tool vocabulary — it never
 * inspects/validates the payload shape (the producing tool owns that). (Audit
 * 2026-05-29, session split.)
 */
export class SessionRepo {
  private readonly read: SessionReadRepo;
  private readonly write: SessionWriteRepo;
  private readonly maintenance: SessionMaintenanceRepo;

  // @yagni-ignore-next-line duplicate-body-candidate -- repository constructors intentionally share the same datastore narrowing idiom; a base class would add indirection without reducing behavior.
  constructor(datastore: DataStore) {
    const drizzle = requireDrizzleHandle(datastore);
    this.read = new SessionReadRepo(drizzle);
    this.write = new SessionWriteRepo(drizzle);
    this.maintenance = new SessionMaintenanceRepo(drizzle);
  }

  save(session: StoredSession): void {
    this.write.save(session);
  }

  list(opts: SessionListOptions = {}): readonly StoredSession[] {
    return this.read.list(opts);
  }

  get(id: string): StoredSession | null {
    return this.read.get(id);
  }

  latest(opts: Parameters<SessionReadRepo['latest']>[0] = {}): StoredSession | null {
    return this.read.latest(opts);
  }

  count(): number {
    return this.read.count();
  }

  pruneToCount(keep: number): number {
    return this.maintenance.pruneToCount(keep);
  }

  purge(before: Date): number {
    return this.maintenance.purge(before);
  }

  clearAll(): number {
    return this.maintenance.clearAll();
  }

  clearForTool(toolId: string): number {
    return this.maintenance.clearForTool(toolId);
  }

  upsertHostMetrics(sessionId: string, metrics: StoredSessionHostMetrics): void {
    this.write.upsertHostMetrics(sessionId, metrics);
  }
}

export {type SessionListOptions} from './session-read-repo.js';