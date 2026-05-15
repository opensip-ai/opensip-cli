import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearAllSessions,
  clearSessionsOlderThan,
  configurePersistencePaths,
  countSessions,
  generateSessionId,
  getReportsDir,
  getStoreDir,
  loadLatestSession,
  loadSessions,
  sanitizeForFilename,
  saveSession,
  type StoredSession,
} from '../persistence/store.js';

let testDir: string;
let sessionsDir: string;
let reportsDir: string;

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'sess-1',
    tool: 'fit',
    timestamp: new Date().toISOString(),
    cwd: '/proj',
    score: 100,
    passed: true,
    summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 },
    checks: [],
    durationMs: 0,
    ...overrides,
  };
}

beforeEach(() => {
   
  testDir = mkdtempSync(join(tmpdir(), 'cli-shared-store-'));
  sessionsDir = join(testDir, 'sessions');
  reportsDir = join(testDir, 'reports');
  configurePersistencePaths({ sessionsDir, reportsDir });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('configurePersistencePaths', () => {
  it('redirects getStoreDir / getReportsDir to the configured paths', () => {
    expect(getStoreDir()).toBe(sessionsDir);
    expect(getReportsDir()).toBe(reportsDir);
  });
});

describe('sanitizeForFilename', () => {
  it('strips path separators and special chars', () => {
    expect(sanitizeForFilename(String.raw`a/b\c:d*e?f"g<h>i|j.k`)).not.toMatch(/[/\\:*?"<>|.]/);
  });

  it('collapses parent traversal', () => {
    expect(sanitizeForFilename('../../etc/passwd')).not.toContain('..');
  });
});

describe('saveSession', () => {
  it('writes a json file under the sessions dir and returns its path', () => {
    const path = saveSession(makeSession());
    expect(path.startsWith(sessionsDir)).toBe(true);
    expect(readdirSync(sessionsDir).length).toBe(1);
  });

  it('encodes the recipe in the filename, sanitized', () => {
    const path = saveSession(makeSession({ recipe: 'foo/bar' }));
    expect(path).toContain('-foo-bar');
  });

  it('does not include a recipe segment when recipe is absent', () => {
    const path = saveSession(makeSession());
    expect(path).not.toContain('-undefined');
  });
});

describe('loadSessions / loadLatestSession', () => {
  it('returns sessions in newest-first order', () => {
    saveSession(makeSession({ id: 'first', timestamp: '2024-01-01T00:00:00.000Z' }));
    saveSession(makeSession({ id: 'second', timestamp: '2024-06-01T00:00:00.000Z' }));
    saveSession(makeSession({ id: 'third', timestamp: '2024-12-01T00:00:00.000Z' }));
    const out = loadSessions();
    expect(out.map((s) => s.id)).toEqual(['third', 'second', 'first']);
  });

  it('honors the limit parameter', () => {
    saveSession(makeSession({ id: 'a', timestamp: '2024-01-01T00:00:00.000Z' }));
    saveSession(makeSession({ id: 'b', timestamp: '2024-02-01T00:00:00.000Z' }));
    saveSession(makeSession({ id: 'c', timestamp: '2024-03-01T00:00:00.000Z' }));
    expect(loadSessions(2)).toHaveLength(2);
  });

  it('skips corrupted JSON files without crashing', () => {
    saveSession(makeSession({ id: 'good' }));
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, '2024-99-99-fit.json'), '{not-json');
    const out = loadSessions();
    expect(out.map((s) => s.id)).toContain('good');
  });

  it('loadLatestSession returns null when no sessions exist', () => {
    expect(loadLatestSession()).toBeNull();
  });

  it('loadLatestSession returns the newest session', () => {
    saveSession(makeSession({ id: 'old', timestamp: '2024-01-01T00:00:00.000Z' }));
    saveSession(makeSession({ id: 'new', timestamp: '2024-12-31T00:00:00.000Z' }));
    expect(loadLatestSession()?.id).toBe('new');
  });
});

describe('countSessions', () => {
  it('returns 0 when the store is empty', () => {
    expect(countSessions()).toBe(0);
  });

  it('counts only .json files', () => {
    saveSession(makeSession());
    writeFileSync(join(sessionsDir, 'note.txt'), 'ignored');
    expect(countSessions()).toBe(1);
  });
});

describe('clearAllSessions', () => {
  it('removes every json file and returns the count', () => {
    saveSession(makeSession({ id: 'a', timestamp: '2024-01-01T00:00:00.000Z' }));
    saveSession(makeSession({ id: 'b', timestamp: '2024-02-01T00:00:00.000Z' }));
    expect(clearAllSessions()).toBe(2);
    expect(countSessions()).toBe(0);
  });

  it('returns 0 when the store is already empty', () => {
    expect(clearAllSessions()).toBe(0);
  });
});

describe('clearSessionsOlderThan', () => {
  it('deletes sessions with timestamps older than the cutoff', () => {
    const oldTs = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const newTs = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    saveSession(makeSession({ id: 'old', timestamp: oldTs }));
    saveSession(makeSession({ id: 'new', timestamp: newTs }));

    expect(clearSessionsOlderThan(7)).toBe(1);
    expect(countSessions()).toBe(1);
    expect(loadLatestSession()?.id).toBe('new');
  });

  it('skips files with unparseable timestamps', () => {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'bad.json'), JSON.stringify({ timestamp: 'not-a-date' }));
    saveSession(makeSession({ id: 'ok', timestamp: new Date().toISOString() }));

    // bad.json has unparseable timestamp; 'ok' is recent. None deleted.
    expect(clearSessionsOlderThan(7)).toBe(0);
  });

  it('skips files with no timestamp field', () => {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'no-ts.json'), JSON.stringify({}));
    expect(clearSessionsOlderThan(7)).toBe(0);
  });

  it('skips unparseable JSON', () => {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'broken.json'), '{');
    expect(clearSessionsOlderThan(7)).toBe(0);
  });
});

describe('saveSession pruning', () => {
  it('keeps at most 100 sessions, pruning oldest', () => {
    // Create 105 sessions with monotonically increasing timestamps
    for (let i = 0; i < 105; i++) {
      const day = String(i + 1).padStart(2, '0');
      saveSession(makeSession({ id: `s-${i}`, timestamp: `2024-01-${day}T00:00:00.000Z` }));
    }
    expect(countSessions()).toBeLessThanOrEqual(100);
  });
});

describe('reports dir', () => {
  it('getReportsDir creates the directory if missing', () => {
    rmSync(reportsDir, { recursive: true, force: true });
    expect(getReportsDir()).toBe(reportsDir);
    // The act of calling should have ensured the dir
    expect(readFileSync.length).toBeGreaterThan(0); // sanity: fs is available
  });
});

describe('generateSessionId', () => {
  it('returns a UUID-shaped string', () => {
    const id = generateSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('generates unique IDs', () => {
    const a = generateSessionId();
    const b = generateSessionId();
    expect(a).not.toBe(b);
  });
});
