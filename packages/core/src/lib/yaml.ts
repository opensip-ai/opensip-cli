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

import { existsSync, readFileSync } from 'node:fs';

import yaml from 'js-yaml';

/**
 * Read a YAML file and return the parsed document. Returns `undefined`
 * on any failure (missing, unreadable, or malformed). Callers that
 * need structured error reporting should use a dedicated loader
 * instead — this helper exists for the discovery seam where "no
 * config" and "bad config" are both treated the same: don't load
 * plugins.
 */
export function readYamlFile(filePath: string): unknown {
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = readFileSync(filePath, 'utf8');
    return yaml.load(raw);
  } catch {
    return undefined;
  }
}
