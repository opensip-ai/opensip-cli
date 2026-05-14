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
 * - File: ~/.opensip-tools/logs/{YYYY-MM-DD}.jsonl (always, even when silent)
 * - stderr: when debug mode is enabled (Ink renders to stdout, logs to stderr)
 *
 * The setSilent(true) flag only suppresses stderr output, NOT file output.
 */

import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Logger {
  debug(msgOrObj: string | Record<string, unknown>, data?: Record<string, unknown>): void;
  info(msgOrObj: string | Record<string, unknown>, data?: Record<string, unknown>): void;
  warn(msgOrObj: string | Record<string, unknown>, data?: Record<string, unknown>): void;
  error(msgOrObj: string | Record<string, unknown>, data?: Record<string, unknown>): void;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let currentLevel: LogLevel = 'warn';
let silent = false;
let debugMode = false;
let runId: string | undefined;
let logDir: string | undefined;
let logFilePath: string | undefined;

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
const MAX_LOG_AGE_DAYS = 7;

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function formatEntry(level: LogLevel, msgOrObj: string | Record<string, unknown>, data?: Record<string, unknown>): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
  };

  if (runId) entry.runId = runId;

  if (typeof msgOrObj === 'string') {
    entry.msg = msgOrObj;
  } else {
    // Spread structured fields (evt, msg, etc.)
    Object.assign(entry, msgOrObj);
  }

  if (data) {
    Object.assign(entry, data);
  }

  return entry;
}

function writeToFile(entry: Record<string, unknown>): void {
  if (!logFilePath) return;
  try {
    appendFileSync(logFilePath, JSON.stringify(entry) + '\n');
  } catch {
    // Best effort — don't crash the CLI if logging fails
  }
}

function writeToStderr(entry: Record<string, unknown>): void {
  if (silent) return;
  if (!debugMode) return;
  try {
    process.stderr.write(JSON.stringify(entry) + '\n');
  } catch {
    // Best effort
  }
}

function shouldWriteToFile(level: LogLevel): boolean {
  // Always write info+ to the log file regardless of silent mode.
  // Silent mode suppresses stderr output (for Ink rendering), not file output.
  // In debug mode, write everything (including debug) to file.
  if (debugMode) return true;
  return LEVELS[level] >= LEVELS.info;
}

function log(level: LogLevel, msgOrObj: string | Record<string, unknown>, data?: Record<string, unknown>): void {
  if (!shouldLog(level) && !logFilePath) return;

  const entry = formatEntry(level, msgOrObj, data);

  // Write to file based on mode
  if (shouldWriteToFile(level)) {
    writeToFile(entry);
  }

  // Write to stderr only when debugMode is on. setSilent(true) is called
  // during preAction so Ink owns stdout; stderr is reserved for --debug.
  if (shouldLog(level)) {
    writeToStderr(entry);
  }
}

export const logger: Logger = {
  debug(msgOrObj, data) { log('debug', msgOrObj, data); },
  info(msgOrObj, data) { log('info', msgOrObj, data); },
  warn(msgOrObj, data) { log('warn', msgOrObj, data); },
  error(msgOrObj, data) { log('error', msgOrObj, data); },
};

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function setSilent(value: boolean): void {
  silent = value;
}

export function setDebugMode(value: boolean): void {
  debugMode = value;
  if (value) {
    currentLevel = 'debug';
  }
}

export function setRunId(id: string): void {
  runId = id;
}

export function getRunId(): string | undefined {
  return runId;
}

/**
 * Initialize the log file for this session.
 * Creates ~/.opensip-tools/logs/ if it doesn't exist.
 * Opens a JSONL file for today's date.
 * Prunes log files older than 7 days.
 */
export function initLogFile(): void {
  try {
    logDir = join(homedir(), '.opensip-tools', 'logs');
    mkdirSync(logDir, { recursive: true });

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    logFilePath = join(logDir, `${today}.jsonl`);

    // Prune old log files
    pruneOldLogs(logDir);
  } catch {
    // Best effort — don't crash if we can't create the log directory
    logFilePath = undefined;
  }
}

function pruneOldLogs(dir: string): void {
  try {
    const cutoff = Date.now() - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000;
    const files = readdirSync(dir);

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      // Extract date from filename: YYYY-MM-DD.jsonl
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
