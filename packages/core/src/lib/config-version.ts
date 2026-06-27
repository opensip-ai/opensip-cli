/**
 * @fileoverview Permissive reader for the top-level `schemaVersion:`
 * field of opensip-cli.config.yml + a compatibility classifier.
 *
 * The CLI's pre-action-hook calls these BEFORE any tool's strict loader
 * runs, so the reader must tolerate every "couldn't determine" case
 * (missing file, malformed YAML, missing field, non-integer field) and
 * treat them all as v1. Forward compat for existing user configs
 * written before the field existed.
 *
 * Lives in `core/lib/` alongside `paths.ts` because version detection
 * is a kernel-level concern; every tool's loader benefits.
 */

import { existsSync } from 'node:fs';

import { readYamlFile } from './yaml.js';

/**
 * The schema version this CLI binary knows how to load. Bumped when
 * the project config structure changes in a way that requires
 * migration.
 */
export const CLI_SUPPORTED_SCHEMA_VERSION = 1 as const;

/** Outcome of `checkSchemaCompat`. */
export type SchemaCompat =
  | { readonly kind: 'ok'; readonly configVersion: number }
  | {
      readonly kind: 'older';
      readonly configVersion: number;
      readonly cliVersion: number;
    }
  | {
      readonly kind: 'cli-too-old';
      readonly configVersion: number;
      readonly cliVersion: number;
    };

/**
 * Read the top-level `schemaVersion:` field. Returns 1 for any
 * "couldn't read it" outcome, by design.
 */
export function readConfigSchemaVersion(configPath: string): number {
  if (!existsSync(configPath)) return 1;
  const doc = readYamlFile(configPath);
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return 1;
  const raw = (doc as Record<string, unknown>).schemaVersion;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return 1;
  return raw;
}

/**
 * Classify a config's declared version against the CLI's supported version.
 *
 *  - 'ok'           — versions match; proceed silently.
 *  - 'older'        — config is older than CLI; CLI can read it (today).
 *                     Future: `opensip-cli migrate` updates it. For
 *                     now the CLI runs it as-is.
 *  - 'cli-too-old'  — config is newer than CLI knows. CLI cannot safely
 *                     load it. User must upgrade the CLI.
 */
export function checkSchemaCompat(configVersion: number): SchemaCompat {
  if (configVersion === CLI_SUPPORTED_SCHEMA_VERSION) {
    return { kind: 'ok', configVersion };
  }
  if (configVersion < CLI_SUPPORTED_SCHEMA_VERSION) {
    return {
      kind: 'older',
      configVersion,
      cliVersion: CLI_SUPPORTED_SCHEMA_VERSION,
    };
  }
  return {
    kind: 'cli-too-old',
    configVersion,
    cliVersion: CLI_SUPPORTED_SCHEMA_VERSION,
  };
}
