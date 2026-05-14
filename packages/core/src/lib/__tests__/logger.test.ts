import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { logger, setLogLevel, setSilent, setDebugMode, setRunId } from '../../lib/logger.js';

describe('logger', () => {
  const stderrCalls: string[] = [];

  beforeEach(() => {
    stderrCalls.length = 0;
    // Reset to defaults before each test
    setLogLevel('warn');
    setSilent(false);
    setDebugMode(false);
    setRunId('');
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderrCalls.push(String(chunk));
      return true;
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('level filtering', () => {
    it('at default level (warn), debug and info do not output', () => {
      setDebugMode(true); // enable stderr output
      setLogLevel('warn'); // but only warn+
      logger.debug('d');
      logger.info('i');

      // stderr.write should not have been called for debug/info
      const calls = stderrCalls;
      const debugCalls = calls.filter(c => c.includes('"level":"debug"'));
      const infoCalls = calls.filter(c => c.includes('"level":"info"'));
      expect(debugCalls).toHaveLength(0);
      expect(infoCalls).toHaveLength(0);
    });

    it('at debug level with debug mode, all levels output to stderr', () => {
      setDebugMode(true); // sets level to debug and enables stderr
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      const calls = stderrCalls;
      expect(calls.some(c => c.includes('"level":"debug"'))).toBe(true);
      expect(calls.some(c => c.includes('"level":"info"'))).toBe(true);
      expect(calls.some(c => c.includes('"level":"warn"'))).toBe(true);
      expect(calls.some(c => c.includes('"level":"error"'))).toBe(true);
    });
  });

  describe('silent mode', () => {
    it('suppresses stderr output when silent is true (even in debug mode)', () => {
      setDebugMode(true);
      setSilent(true);

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(stderrCalls).toHaveLength(0);
    });

    it('resumes stderr output when silent is turned off', () => {
      setDebugMode(true);
      setSilent(true);
      logger.debug('silent');
      setSilent(false);
      logger.debug('audible');

      const calls = stderrCalls;
      expect(calls.some(c => c.includes('"msg":"audible"'))).toBe(true);
      expect(calls.some(c => c.includes('"msg":"silent"'))).toBe(false);
    });
  });

  describe('structured output', () => {
    it('outputs JSON with ts, level, and msg fields', () => {
      setDebugMode(true);
      logger.debug('hello world');

      expect(stderrCalls.length).toBeGreaterThan(0);
      const output = stderrCalls[0];
      const entry = JSON.parse(output.trim());
      expect(entry.ts).toBeDefined();
      expect(entry.level).toBe('debug');
      expect(entry.msg).toBe('hello world');
    });

    it('includes runId when set', () => {
      setDebugMode(true);
      setRunId('RUN_test123');
      logger.debug('test');

      const output = stderrCalls[0];
      const entry = JSON.parse(output.trim());
      expect(entry.runId).toBe('RUN_test123');
    });

    it('spreads structured object fields into the entry', () => {
      setDebugMode(true);
      logger.debug({ evt: 'cli.start', msg: 'starting', cwd: '/tmp' });

      const output = stderrCalls[0];
      const entry = JSON.parse(output.trim());
      expect(entry.evt).toBe('cli.start');
      expect(entry.msg).toBe('starting');
      expect(entry.cwd).toBe('/tmp');
    });

    it('merges data parameter into the entry', () => {
      setDebugMode(true);
      logger.debug('test', { extra: 42 });

      const output = stderrCalls[0];
      const entry = JSON.parse(output.trim());
      expect(entry.msg).toBe('test');
      expect(entry.extra).toBe(42);
    });
  });

  describe('debug mode', () => {
    it('does not output to stderr when debug mode is off', () => {
      setLogLevel('debug');
      // debugMode is false by default
      logger.debug('invisible');

      expect(stderrCalls).toHaveLength(0);
    });

    it('outputs to stderr when debug mode is on', () => {
      setDebugMode(true);
      logger.debug('visible');

      expect(stderrCalls.length).toBeGreaterThan(0);
    });
  });
});
