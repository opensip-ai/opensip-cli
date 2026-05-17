import { mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type * as cliShared from '@opensip-tools/contracts';

type StoredSession = cliShared.StoredSession;

let tempRoot = '';

function makeTempDir(): string {
  const dir = join(tmpdir(), `cli-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: overrides.id ?? 'test-id',
    tool: overrides.tool ?? 'fit',
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    // eslint-disable-next-line sonarjs/publicly-writable-directories -- test fixture cwd; not a runtime filesystem operation
    cwd: overrides.cwd ?? '/tmp/project',
    recipe: overrides.recipe,
    score: overrides.score ?? 85,
    passed: overrides.passed ?? true,
    summary: overrides.summary ?? { total: 10, passed: 8, failed: 2, errors: 1, warnings: 3 },
    checks: overrides.checks ?? [],
    durationMs: overrides.durationMs ?? 1234,
  };
}

describe('persistence/store', () => {
  let storeModule: typeof cliShared;

  beforeEach(async () => {
    tempRoot = makeTempDir();
    // Force fresh import so module-level state is reset between tests.
    vi.resetModules();
    storeModule = await import('@opensip-tools/contracts');
    storeModule.configurePersistencePaths({
      sessionsDir: join(tempRoot, 'sessions'),
      reportsDir: join(tempRoot, 'reports'),
    });
  });

  afterEach(() => {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('sanitizeForFilename', () => {
    it('strips path separators', () => {
      expect(storeModule.sanitizeForFilename(String.raw`foo/bar\baz`)).toBe('foo-bar-baz');
    });

    it('strips special characters', () => {
      expect(storeModule.sanitizeForFilename('a:b*c?d"e<f>g|h')).toBe('a-b-c-d-e-f-g-h');
    });

    it('strips dots (used in path traversal)', () => {
      // ../../etc/passwd -> .. collapsed first, then individual special chars replaced
      const result = storeModule.sanitizeForFilename('../../etc/passwd');
      expect(result).not.toContain('/');
      expect(result).not.toContain('.');
      expect(result).toBe('----etc-passwd');
    });

    it('handles empty string', () => {
      expect(storeModule.sanitizeForFilename('')).toBe('');
    });

    it('passes through safe characters', () => {
      expect(storeModule.sanitizeForFilename('my-recipe_name123')).toBe('my-recipe_name123');
    });
  });

  describe('saveSession + loadSessions round-trip', () => {
    it('saves and loads a session correctly', () => {
      const session = makeSession({ id: 'round-trip-1', score: 92 });
      storeModule.saveSession(session);

      const loaded = storeModule.loadSessions();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('round-trip-1');
      expect(loaded[0].score).toBe(92);
      expect(loaded[0].summary).toEqual(session.summary);
    });

    it('saves multiple sessions and loads them newest first', () => {
      const s1 = makeSession({ id: 'first', timestamp: '2025-01-01T00:00:00.000Z' });
      const s2 = makeSession({ id: 'second', timestamp: '2025-06-01T00:00:00.000Z' });
      storeModule.saveSession(s1);
      storeModule.saveSession(s2);

      const loaded = storeModule.loadSessions();
      expect(loaded).toHaveLength(2);
      // Newest first (sorted by filename which includes timestamp)
      expect(loaded[0].id).toBe('second');
      expect(loaded[1].id).toBe('first');
    });

    it('saves session with recipe in filename', () => {
      const session = makeSession({ recipe: 'quick-smoke' });
      const filepath = storeModule.saveSession(session);
      expect(filepath).toContain('quick-smoke');
    });
  });

  describe('loadLatestSession', () => {
    it('returns null when no sessions exist', () => {
      const result = storeModule.loadLatestSession();
      expect(result).toBeNull();
    });

    it('returns only the most recent session', () => {
      const s1 = makeSession({ id: 'older', timestamp: '2025-01-01T00:00:00.000Z' });
      const s2 = makeSession({ id: 'newer', timestamp: '2025-06-01T00:00:00.000Z' });
      storeModule.saveSession(s1);
      storeModule.saveSession(s2);

      const latest = storeModule.loadLatestSession();
      expect(latest).not.toBeNull();
      expect(latest!.id).toBe('newer');
    });
  });

  describe('loadSessions with limit', () => {
    it('respects the limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        storeModule.saveSession(makeSession({
          id: `session-${i}`,
          timestamp: `2025-0${i + 1}-01T00:00:00.000Z`,
        }));
      }

      const loaded = storeModule.loadSessions(2);
      expect(loaded).toHaveLength(2);
    });
  });

  describe('empty sessions directory', () => {
    it('returns empty array when sessions dir has no JSON files', () => {
      const loaded = storeModule.loadSessions();
      expect(loaded).toEqual([]);
    });
  });

  describe('corrupted file handling', () => {
    it('skips corrupted JSON files without crashing', async () => {
      // Save a valid session first
      storeModule.saveSession(makeSession({ id: 'valid', timestamp: '2025-06-01T00:00:00.000Z' }));

      // Write a corrupted file directly
      const storeDir = storeModule.getStoreDir();
      writeFileSync(join(storeDir, '2025-01-01T00-00-00-000Z-fit.json'), 'NOT VALID JSON{{{', 'utf8');

      const { logger } = await import('@opensip-tools/core');
      const loggerSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {
        /* swallow logged warning during test */
      });
      const loaded = storeModule.loadSessions();
      // Should have loaded only the valid session
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('valid');
      expect(loggerSpy).toHaveBeenCalledWith(expect.objectContaining({ evt: 'cli.session.corrupted' }));
      loggerSpy.mockRestore();
    });
  });

  describe('path traversal prevention', () => {
    it('saveSession uses basename to prevent directory traversal in recipe names', () => {
      const session = makeSession({ recipe: '../../etc/passwd' });
      const filepath = storeModule.saveSession(session);
      // The filepath should stay within the sessions directory
      const storeDir = storeModule.getStoreDir();
      expect(filepath.startsWith(storeDir)).toBe(true);
      // Should not contain ..
      expect(filepath).not.toContain('..');
    });
  });

  describe('pruning', () => {
    it('prunes sessions beyond MAX_SESSIONS (100)', () => {
      // Create 105 sessions with unique timestamps
      for (let i = 0; i < 105; i++) {
        const day = String(Math.floor(i / 24) + 1).padStart(2, '0');
        const hour = String(i % 24).padStart(2, '0');
        const min = String(Math.floor(i / 100)).padStart(2, '0');
        const sec = String(i % 60).padStart(2, '0');
        storeModule.saveSession(makeSession({
          id: `session-${i}`,
          timestamp: `2025-01-${day}T${hour}:${min}:${sec}.000Z`,
        }));
      }

      const storeDir = storeModule.getStoreDir();
      const files = readdirSync(storeDir).filter(f => f.endsWith('.json'));
      expect(files.length).toBeLessThanOrEqual(100);
    });
  });

  describe('generateSessionId', () => {
    it('returns a valid UUID string', () => {
      const id = storeModule.generateSessionId();
      // UUID v4 format
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('generates unique IDs on consecutive calls', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(storeModule.generateSessionId());
      }
      expect(ids.size).toBe(100);
    });
  });

  describe('getReportsDir', () => {
    it('creates the reports directory if it does not exist', () => {
      const reportsDir = storeModule.getReportsDir();
      expect(reportsDir).toContain('reports');
      // Directory should exist after the call
      const entries = readdirSync(reportsDir);
      expect(entries).toBeDefined();
    });
  });
});
