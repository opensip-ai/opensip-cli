/**
 * @fileoverview Permissive YAML reader used by plugin-discovery sites
 * that need to extract a single field from `opensip-tools.config.yml`
 * without dragging in a Zod schema or surfacing structured errors.
 *
 * The kernel's plugin discovery (and fitness's check-package discovery)
 * only need to read `plugins.<domain>` / `plugins.checkPackages`
 * out of the project config. They previously reached for js-yaml via a
 * `createRequire(import.meta.url)` shim — duplicated, and unnecessary
 * now that `js-yaml` is a direct dep of every package that calls this.
 *
 * Behavior:
 *   - Missing file → `undefined`
 *   - I/O error → `undefined`
 *   - Malformed YAML → `undefined`
 *   - Valid YAML → parsed value (typed `unknown`; callers narrow)
 *
 * Strict YAML loading (with structured errors and size caps) is the
 * targets loader's job — it lives in fitness because the schema lives
 * there. Don't add error-throwing modes here; that's a different tool's
 * surface.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';

import yaml from 'js-yaml';

import { SystemError, ValidationError } from './errors.js';
import { logger } from './logger.js';

/**
 * Read a YAML file and return the parsed document. Returns `undefined`
 * on any failure (missing, unreadable, or malformed). Callers that
 * need structured error reporting should use a dedicated loader
 * instead — this helper exists for the discovery seam where "no
 * config" and "bad config" are both treated the same: don't load
 * plugins.
 *
 * @remarks Advanced / discouraged for general use. This is the
 * "permissive" reader for plugin discovery; tools that read their
 * own config should keep a dedicated loader (see fitness's
 * targets/loader.ts) so malformed YAML surfaces a structured error
 * instead of silently no-op'ing.
 *
 * On parse failure we still emit a `core.yaml.parse_failed` debug
 * log so a `--debug` run reveals the cause — "permissive" should
 * not mean "silent" at the kernel layer.
 */
export function readYamlFile(filePath: string): unknown {
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = readFileSync(filePath, 'utf8');
    return yaml.load(raw);
  } catch (error) {
    logger.debug({
      evt: 'core.yaml.parse_failed',
      module: 'core:lib',
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Knobs for {@link readYamlFileOrThrow}: size guard and loader attribution. */
export interface ReadYamlFileOrThrowOptions {
  /**
   * Maximum file size in bytes before this loader refuses to read.
   * Defaults to 10 MB — a project config file that grows past this is
   * almost certainly checked-in test data or a bug.
   */
  readonly maxBytes?: number;
  /**
   * Loader name surfaced in `ValidationError.options.loader` so
   * downstream error rendering can attribute failures to the right
   * subsystem (e.g. `'signalers'`, `'cli-defaults'`).
   */
  readonly loader?: string;
}

/**
 * Strict counterpart to `readYamlFile`. Throws structured errors on
 * any failure mode instead of returning `undefined`:
 *
 *   - `ValidationError` — missing file, unreadable file, malformed YAML.
 *     The `loader` and `operation` fields are populated for downstream
 *     attribution.
 *   - `SystemError` — file exceeds `maxBytes` (default 10 MB).
 *
 * Consumers that want hand-rolled stat/read/parse with the same
 * structured errors should call this instead — it consolidates a
 * pattern previously duplicated across loaders (audit-round-2 Finding F).
 *
 * @throws {ValidationError} When the file is missing, unreadable, or contains malformed YAML.
 * @throws {SystemError} When the file exceeds `maxBytes`.
 */
export function readYamlFileOrThrow(
  filePath: string,
  options: ReadYamlFileOrThrowOptions = {},
): unknown {
  const loader = options.loader ?? 'yaml';
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;

  let raw: string;
  try {
    const stats = statSync(filePath);
    if (stats.size > maxBytes) {
      throw new SystemError(
        `File too large (${stats.size} bytes, max ${maxBytes}): ${filePath}`,
        { code: 'SYSTEM.FILE.TOO_LARGE', operation: 'read', loader, filePath },
      );
    }
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error instanceof SystemError || error instanceof ValidationError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ValidationError(`Failed to read ${filePath}: ${message}`, {
      operation: 'read',
      loader,
      filePath,
      cause: error instanceof Error ? error : undefined,
    });
  }

  try {
    return yaml.load(raw) ?? {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ValidationError(`${filePath} contains invalid YAML: ${message}`, {
      operation: 'parse',
      loader,
      filePath,
      cause: error instanceof Error ? error : undefined,
    });
  }
}
