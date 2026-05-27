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
 *   The CLI bootstrap supplies this path via initLogFile(). Without
 *   initLogFile(), file output is disabled — user-global state
 *   (`~/.opensip-tools/`) is reserved for config.yml only.
 * - stderr: when debug mode is enabled (Ink renders to stdout, logs to stderr)
 *
 * The setSilent(true) flag only suppresses stderr output, NOT file output.
 *
 * Two access patterns:
 *
 *   1. The exported `logger` singleton + `setLogLevel` / `setSilent` /
 *      ... helper functions. Used by CLI bootstrap and any production
 *      caller that wants the process-wide configuration.
 *
 *   2. The exported `LoggerImpl` class. Used by tests (or tools that
 *      need an isolated logger) to construct a fresh instance whose
 *      state is independent of the singleton.
 */

import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface Logger {
  debug(msgOrObj: string | Record<string, unknown>, data?: Record<string, unknown>): void;
  info(msgOrObj: string | Record<string, unknown>, data?: Record<string, unknown>): void;
  warn(msgOrObj: string | Record<string, unknown>, data?: Record<string, unknown>): void;
  error(msgOrObj: string | Record<string, unknown>, data?: Record<string, unknown>): void;
}

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
 * Construction-time options for `LoggerImpl`. Replaces the prior
 * `setLogLevel(level)` free mutator — callers that need a non-default
 * level construct a fresh logger with `new LoggerImpl({ level })`.
 */
export interface LoggerOptions {
  /** Initial log level. Defaults to `'warn'`. */
  readonly level?: LogLevel;
}

export class LoggerImpl implements Logger {
  private currentLevel: LogLevel;
  private silent = false;
  private debugMode = false;
  private runId: string | undefined;
  private logFilePath: string | undefined;

  constructor(opts: LoggerOptions = {}) {
    this.currentLevel = opts.level ?? 'warn';
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

  setSilent(value: boolean): void {
    this.silent = value;
  }

  setDebugMode(value: boolean): void {
    this.debugMode = value;
    if (value) this.currentLevel = 'debug';
  }

  setRunId(id: string): void {
    this.runId = id;
  }

  getRunId(): string | undefined {
    return this.runId;
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

    const entry = formatEntry(level, msgOrObj, data, this.runId);

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
 * Process-wide logger singleton. CLI bootstrap configures it via the
 * setter functions below; production callers import this constant
 * directly. Tests should construct a fresh `new LoggerImpl()` instead
 * of mutating the singleton's state.
 *
 * Typed as the `Logger` interface (not the concrete class) so generic
 * call sites see only the four log-level methods. Configuration
 * (`setDebugMode`, `setLogLevel`, `initLogFile`, …) is the CLI
 * bootstrap's job and reaches the underlying instance through the
 * helper functions below.
 */
const _logger = new LoggerImpl();
export const logger: Logger = _logger;

export function setSilent(value: boolean): void {
  _logger.setSilent(value);
}

export function setDebugMode(value: boolean): void {
  _logger.setDebugMode(value);
}

export function setRunId(id: string): void {
  _logger.setRunId(id);
}

export function getRunId(): string | undefined {
  return _logger.getRunId();
}

export function initLogFile(dir: string): void {
  _logger.initLogFile(dir);
}
