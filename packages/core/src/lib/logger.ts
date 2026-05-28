// @fitness-ignore-file error-handling-quality -- this module IS the logger; its own write/prune failures cannot be reported via itself without infinite recursion. Best-effort swallow is the documented contract on lines 273/281/297/302.
// @fitness-ignore-file interface-implementation-consistency -- LoggerImpl deliberately exposes configuration methods (applyOptions/setSilent/setDebugMode/setRunId/getRunId/setRunIdProvider/initLogFile) that are not on the public `Logger` interface. The interface is the narrow log-emission seam used by call sites; the impl's wider surface is the bootstrap/test configuration surface (see JSDoc on LoggerImpl).
/**
 * Structured logger for opensip-tools.
 *
 * Outputs JSON log lines with:
 * - ts: ISO timestamp
 * - level: debug | info | warn | error
 * - evt: event name (e.g., 'cli.start', 'cli.check.complete')
 * - runId: correlation ID for the current CLI invocation
 * - msg: human-readable message
 * - ...data: additional structured fields
 *
 * Destinations:
 * - File: <project>/opensip-tools/.runtime/logs/{YYYY-MM-DD}.jsonl
 *   The CLI bootstrap supplies this path via configureLogger({ logDir }).
 *   Without that, file output is disabled — user-global state
 *   (`~/.opensip-tools/`) is reserved for config.yml only.
 * - stderr: when debug mode is enabled (Ink renders to stdout, logs to stderr)
 *
 * The `silent: true` option only suppresses stderr output, NOT file output.
 *
 * Two access patterns:
 *
 *   1. The exported `logger` singleton + `configureLogger(opts)`. Used
 *      by the CLI bootstrap and any production caller that wants the
 *      process-wide configuration. The four prior free mutators
 *      (`setSilent`, `setDebugMode`, `setRunId`, `initLogFile`) were
 *      collapsed into `configureLogger` in T1 deferred Item C.
 *
 *   2. The exported `LoggerImpl` class. Used by tests (or tools that
 *      need an isolated logger) to construct a fresh instance whose
 *      state is independent of the singleton.
 */

import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Structured logger surface; accepts a message string or a structured record. */
export interface Logger {
  debug(msgOrObj: string | Record<string, unknown>, data?: Record<string, unknown>): void;
  info(msgOrObj: string | Record<string, unknown>, data?: Record<string, unknown>): void;
  warn(msgOrObj: string | Record<string, unknown>, data?: Record<string, unknown>): void;
  error(msgOrObj: string | Record<string, unknown>, data?: Record<string, unknown>): void;
}

/** Log severity levels, ordered from most to least verbose. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
const MAX_LOG_AGE_DAYS = 7;

/**
 * Concrete logger implementation. Production code uses the exported
 * `logger` singleton (typed as the `Logger` interface so the
 * configuration surface is hidden from generic call sites); tests
 * (or tools that need an isolated logger) can construct a fresh
 * `LoggerImpl()` to exercise the logger without polluting (or being
 * polluted by) the singleton's state.
 *
 * @remarks Treat this class as advanced / discouraged for general
 * production use — the `Logger` interface is the seam. Importing
 * `LoggerImpl` is appropriate for tests and for tools that genuinely
 * need an isolated logger; everywhere else the typed `logger`
 * singleton is the right import.
 */
/**
 * Construction-time options for `LoggerImpl`. Also the shape accepted
 * by `configureLogger(opts)`, the single bootstrap-time configuration
 * seam that replaced the four free mutators (`setSilent`,
 * `setDebugMode`, `setRunId`, `initLogFile`) — T1 deferred Item C.
 */
export interface LoggerOptions {
  /** Initial log level. Defaults to `'warn'`. */
  readonly level?: LogLevel;
  /** Suppress stderr output (file output still occurs). Defaults to `false`. */
  readonly silent?: boolean;
  /** Enable debug-level output to stderr. Defaults to `false`. */
  readonly debugMode?: boolean;
  /** Correlation id for the current CLI invocation. */
  readonly runId?: string;
  /**
   * Directory the daily `.jsonl` log file is written to. When provided,
   * the logger initialises the file path and prunes logs older than
   * 7 days. Best-effort; failures are swallowed.
   */
  readonly logDir?: string;
}

/**
 * Optional indirection for the runId on each log entry. The CLI binds
 * this to `() => currentScope()?.runId` at module init (in run-scope.ts,
 * which already depends on logger.ts — this preserves the dependency
 * direction and avoids a logger→run-scope import cycle that depcruise
 * would reject). Returns `undefined` when no scope is bound, in which
 * case `LoggerImpl.log` falls back to its instance-level `runId`.
 *
 * Tests that construct an isolated `new LoggerImpl()` skip this path
 * entirely — they call `setRunId(...)` on the instance.
 */
export type RunIdProvider = () => string | undefined;

/** Concrete logger writing JSONL to stderr and an optional daily file. */
export class LoggerImpl implements Logger {
  private currentLevel: LogLevel;
  private silent = false;
  private debugMode = false;
  private runId: string | undefined;
  private logFilePath: string | undefined;
  private runIdProvider: RunIdProvider | undefined;

  constructor(opts: LoggerOptions = {}) {
    this.currentLevel = opts.level ?? 'warn';
    this.applyOptions(opts);
  }

  /**
   * Apply a `LoggerOptions` bag to this instance. Used by the singleton
   * via `configureLogger(opts)` — the bootstrap-time configuration seam
   * that collapsed the four prior free mutators into one shot. Each
   * field is independent: an `applyOptions({ silent: true })` leaves
   * `debugMode` and `runId` alone.
   */
  applyOptions(opts: LoggerOptions): void {
    if (opts.level !== undefined) this.currentLevel = opts.level;
    if (opts.silent !== undefined) this.silent = opts.silent;
    if (opts.debugMode !== undefined) {
      this.debugMode = opts.debugMode;
      if (opts.debugMode) this.currentLevel = 'debug';
    }
    if (opts.runId !== undefined) this.runId = opts.runId;
    if (opts.logDir !== undefined) this.initLogFile(opts.logDir);
  }

  debug(msgOrObj: string | Record<string, unknown>, data?: Record<string, unknown>): void {
    this.log('debug', msgOrObj, data);
  }
  info(msgOrObj: string | Record<string, unknown>, data?: Record<string, unknown>): void {
    this.log('info', msgOrObj, data);
  }
  warn(msgOrObj: string | Record<string, unknown>, data?: Record<string, unknown>): void {
    this.log('warn', msgOrObj, data);
  }
  error(msgOrObj: string | Record<string, unknown>, data?: Record<string, unknown>): void {
    this.log('error', msgOrObj, data);
  }

  /**
   * Suppress stderr output. File output still occurs. Used by the CLI
   * to silence the logger during Ink renders (Ink owns stdout; stderr
   * is reserved for `--debug` traces). Tests use this on fresh
   * `new LoggerImpl()` instances to verify the silent-mode contract.
   */
  setSilent(value: boolean): void {
    this.silent = value;
  }

  /**
   * Enable debug-level output to stderr. Sets the current level to
   * `'debug'` when enabled. Disabling does NOT restore a prior level.
   */
  setDebugMode(value: boolean): void {
    this.debugMode = value;
    if (value) this.currentLevel = 'debug';
  }

  /** Set the correlation id stamped on each log entry. */
  setRunId(id: string): void {
    this.runId = id;
  }

  getRunId(): string | undefined {
    return this.runId;
  }

  /**
   * Inject a runId source consulted on every `log()`. Lets the kernel
   * route the singleton through the RunScope-bound runId without the
   * logger module having to import run-scope.ts (which would create a
   * cycle, since run-scope already imports the logger).
   */
  setRunIdProvider(provider: RunIdProvider | undefined): void {
    this.runIdProvider = provider;
  }

  /**
   * Initialize the log file for this instance.
   *
   * Writes to `<dir>/<YYYY-MM-DD>.jsonl`; the CLI bootstrap supplies
   * the path from `resolveProjectPaths(cwd).logsDir`. Without a call
   * to this function, file output is disabled (logs still hit stderr
   * in debug mode).
   *
   * Prunes log files older than 7 days inside the chosen directory.
   *
   * @internal — production callers route through `configureLogger`'s
   * `logDir` option. The method is `private` from a domain-design
   * standpoint but TypeScript can't mark it `private` because the
   * constructor calls it via `applyOptions`.
   */
  initLogFile(dir: string): void {
    try {
      mkdirSync(dir, { recursive: true });
      const today = new Date().toISOString().slice(0, 10);
      this.logFilePath = join(dir, `${today}.jsonl`);
      pruneOldLogs(dir);
    } catch {
      // Best effort — don't crash if we can't create the log directory
      this.logFilePath = undefined;
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVELS[level] >= LEVELS[this.currentLevel];
  }

  private shouldWriteToFile(level: LogLevel): boolean {
    // Always write info+ to the log file regardless of silent mode.
    // Silent mode suppresses stderr output (for Ink rendering), not file output.
    // In debug mode, write everything (including debug) to file.
    if (this.debugMode) return true;
    return LEVELS[level] >= LEVELS.info;
  }

  private log(level: LogLevel, msgOrObj: string | Record<string, unknown>, data?: Record<string, unknown>): void {
    if (!this.shouldLog(level) && !this.logFilePath) return;

    // RunScope-bound runId wins over the instance-level field.
    // Production callers always go through the singleton inside a
    // `runWithScope`/`enterScope` block; the kernel binds a
    // `runIdProvider` at module init that reads `currentScope()?.runId`
    // (Item 2 — runId moved off the singleton onto RunScope as a flat
    // kernel field). Tests that construct an isolated `new LoggerImpl()`
    // outside any scope still get instance-level runId via the fallback.
    const scopedRunId = this.runIdProvider?.();
    const effectiveRunId = (scopedRunId !== undefined && scopedRunId !== '') ? scopedRunId : this.runId;
    const entry = formatEntry(level, msgOrObj, data, effectiveRunId);

    if (this.shouldWriteToFile(level)) {
      writeToFile(this.logFilePath, entry);
    }

    // Write to stderr only when debugMode is on. setSilent(true) is called
    // during preAction so Ink owns stdout; stderr is reserved for --debug.
    if (this.shouldLog(level) && this.debugMode && !this.silent) {
      writeToStderr(entry);
    }
  }
}

function formatEntry(
  level: LogLevel,
  msgOrObj: string | Record<string, unknown>,
  data: Record<string, unknown> | undefined,
  runId: string | undefined,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
  };

  if (runId) entry.runId = runId;

  if (typeof msgOrObj === 'string') {
    entry.msg = msgOrObj;
  } else {
    Object.assign(entry, msgOrObj);
  }

  if (data) Object.assign(entry, data);
  return entry;
}

function writeToFile(logFilePath: string | undefined, entry: Record<string, unknown>): void {
  if (!logFilePath) return;
  try {
    appendFileSync(logFilePath, JSON.stringify(entry) + '\n');
  } catch {
    // Best effort — don't crash the CLI if logging fails
  }
}

function writeToStderr(entry: Record<string, unknown>): void {
  try {
    process.stderr.write(JSON.stringify(entry) + '\n');
  } catch {
    // Best effort
  }
}

function pruneOldLogs(dir: string): void {
  try {
    const cutoff = Date.now() - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000;
    const files = readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const dateStr = file.replace('.jsonl', '');
      const fileDate = new Date(dateStr).getTime();
      if (!Number.isNaN(fileDate) && fileDate < cutoff) {
        try {
          unlinkSync(join(dir, file));
        } catch {
          // Skip files we can't delete
        }
      }
    }
  } catch {
    // Best effort
  }
}

// =============================================================================
// SINGLETON + COMPATIBILITY HELPERS
// =============================================================================

/**
 * Process-wide logger singleton. CLI bootstrap configures it via
 * `configureLogger(opts)` once at startup; production callers import
 * this constant directly. Tests should construct a fresh
 * `new LoggerImpl({...})` instead of mutating the singleton's state.
 *
 * Typed as the `Logger` interface (not the concrete class) so generic
 * call sites see only the four log-level methods. Configuration
 * reaches the underlying instance through `configureLogger`, which is
 * the only seam — the four free mutators (`setSilent`, `setDebugMode`,
 * `setRunId`, `initLogFile`) that previously existed are gone
 * (T1 deferred Item C).
 */
const _logger = new LoggerImpl();
export const logger: Logger = _logger;

/**
 * One-shot configuration for the process-wide `logger` singleton.
 * Replaces the four free mutators that previously each mutated one
 * field. The CLI's pre-action-hook calls this once with all relevant
 * options after flags are parsed and the project context is resolved.
 *
 * SaaS hosts that run multiple invocations concurrently should NOT use
 * this — they construct per-invocation `new LoggerImpl({...})` and
 * wire it into the `RunScope.logger` field so each run has its own
 * file path and runId.
 */
export function configureLogger(opts: LoggerOptions): void {
  _logger.applyOptions(opts);
}
