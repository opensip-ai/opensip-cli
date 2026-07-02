import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import { CLI_SUPPORTED_SCHEMA_VERSION, ConfigurationError } from '@opensip-cli/core';
import { isMap, isScalar, parseDocument, type Document as YAMLDocument, type YAMLMap } from 'yaml';

/** Maximum project-config size accepted by the migration command. */
export const MAX_CONFIG_MIGRATION_BYTES = 1_048_576;

/** Change categories emitted by the project-config migration planner. */
export type ConfigMigrationOperationKind =
  | 'add-schema-version'
  | 'normalize-schema-version'
  | 'bump-schema-version';

/** One human-readable operation applied, or proposed, during config migration. */
export interface ConfigMigrationOperation {
  readonly kind: ConfigMigrationOperationKind;
  readonly fromVersion?: number;
  readonly toVersion: number;
  readonly message: string;
}

/** Inputs for migrating already-read `opensip-cli.config.yml` text. */
export interface MigrateConfigTextInput {
  readonly text: string;
  readonly configPath?: string;
  readonly targetVersion?: number;
}

/** Result of normalizing project-config text to the supported schema version. */
export interface MigrateConfigTextResult {
  readonly changed: boolean;
  readonly fromVersion: number;
  readonly targetVersion: number;
  readonly migratedText: string;
  readonly operations: readonly ConfigMigrationOperation[];
}

/** Inputs for migrating an `opensip-cli.config.yml` file on disk. */
export interface MigrateConfigFileInput {
  readonly configPath: string;
  readonly dryRun?: boolean;
  readonly maxBytes?: number;
  readonly targetVersion?: number;
}

/** Result of a project-config file migration, including whether the file was written. */
export interface MigrateConfigFileResult extends MigrateConfigTextResult {
  readonly configPath: string;
  readonly dryRun: boolean;
  readonly wrote: boolean;
}

interface SchemaVersionRead {
  readonly status: 'missing' | 'valid' | 'invalid';
  readonly version: number;
}

function configLabel(configPath: string | undefined): string {
  return configPath ?? 'opensip-cli.config.yml';
}

function validateTargetVersion(targetVersion: number): void {
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    throw new ConfigurationError(
      `Cannot migrate config: target schema version must be a positive integer.`,
      { code: 'CONFIG.MIGRATION.INVALID_TARGET_VERSION' },
    );
  }
}

function readSchemaVersion(root: YAMLMap): SchemaVersionRead {
  if (!root.has('schemaVersion')) return { status: 'missing', version: 1 };
  const node = root.get('schemaVersion', true);
  if (!isScalar(node)) return { status: 'invalid', version: 1 };
  const value = node.value;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return { status: 'invalid', version: 1 };
  }
  return { status: 'valid', version: value };
}

function parseConfigDocument(text: string, configPath: string | undefined) {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    const first = doc.errors[0]?.message ?? 'unknown YAML error';
    throw new ConfigurationError(`Cannot migrate ${configLabel(configPath)}: ${first}.`, {
      code: 'CONFIG.MIGRATION.MALFORMED_YAML',
    });
  }
  return doc;
}

function ensureRootMap(doc: YAMLDocument, configPath: string | undefined): YAMLMap {
  doc.contents ??= doc.createNode({});
  if (!isMap(doc.contents)) {
    throw new ConfigurationError(
      `Cannot migrate ${configLabel(configPath)}: opensip-cli.config.yml must start with a YAML map.`,
      { code: 'CONFIG.MIGRATION.NON_MAP_CONFIG' },
    );
  }
  return doc.contents;
}

function migrationOperation(
  read: SchemaVersionRead,
  targetVersion: number,
): ConfigMigrationOperation | undefined {
  if (read.status === 'missing') {
    return {
      kind: 'add-schema-version',
      toVersion: targetVersion,
      message: `Added schemaVersion: ${String(targetVersion)}.`,
    };
  }
  if (read.status === 'invalid') {
    return {
      kind: 'normalize-schema-version',
      fromVersion: read.version,
      toVersion: targetVersion,
      message: `Normalized schemaVersion to ${String(targetVersion)}.`,
    };
  }
  if (read.version < targetVersion) {
    return {
      kind: 'bump-schema-version',
      fromVersion: read.version,
      toVersion: targetVersion,
      message: `Bumped schemaVersion from ${String(read.version)} to ${String(targetVersion)}.`,
    };
  }
  return undefined;
}

/**
 * Parse and normalize project-config YAML text to the current supported schema.
 *
 * @throws {ConfigurationError} When the YAML is malformed, non-map, invalid, or newer than this CLI supports.
 */
export function migrateConfigText(input: MigrateConfigTextInput): MigrateConfigTextResult {
  const targetVersion = input.targetVersion ?? CLI_SUPPORTED_SCHEMA_VERSION;
  validateTargetVersion(targetVersion);
  const doc = parseConfigDocument(input.text, input.configPath);
  const root = ensureRootMap(doc, input.configPath);
  const read = readSchemaVersion(root);
  if (read.version > targetVersion) {
    throw new ConfigurationError(
      `Cannot migrate ${configLabel(input.configPath)}: schemaVersion ${String(read.version)} is newer than this CLI supports (${String(targetVersion)}). Update OpenSIP CLI before editing this config.`,
      { code: 'CONFIG.MIGRATION.CLI_TOO_OLD' },
    );
  }
  const operation = migrationOperation(read, targetVersion);
  if (operation === undefined) {
    return {
      changed: false,
      fromVersion: read.version,
      targetVersion,
      migratedText: input.text,
      operations: [],
    };
  }
  root.set('schemaVersion', targetVersion);
  return {
    changed: true,
    fromVersion: read.version,
    targetVersion: operation.toVersion,
    migratedText: doc.toString(),
    operations: [operation],
  };
}

/**
 * Migrate an `opensip-cli.config.yml` file in place, or report pending changes in dry-run mode.
 *
 * @throws {ConfigurationError} When the file is missing, oversized, malformed, invalid, or newer than this CLI supports.
 */
export function migrateConfigFile(input: MigrateConfigFileInput): MigrateConfigFileResult {
  if (!existsSync(input.configPath)) {
    throw new ConfigurationError(`Cannot migrate ${input.configPath}: file does not exist.`, {
      code: 'CONFIG.MIGRATION.NOT_FOUND',
    });
  }
  const maxBytes = input.maxBytes ?? MAX_CONFIG_MIGRATION_BYTES;
  const stat = statSync(input.configPath);
  if (stat.size > maxBytes) {
    throw new ConfigurationError(
      `Cannot migrate ${input.configPath}: file is larger than ${String(maxBytes)} bytes.`,
      { code: 'CONFIG.MIGRATION.CONFIG_TOO_LARGE' },
    );
  }
  const result = migrateConfigText({
    text: readFileSync(input.configPath, 'utf8'),
    configPath: input.configPath,
    targetVersion: input.targetVersion,
  });
  const dryRun = input.dryRun === true;
  const wrote = result.changed && !dryRun;
  if (wrote) {
    writeFileSync(input.configPath, result.migratedText, 'utf8');
  }
  return {
    ...result,
    configPath: input.configPath,
    dryRun,
    wrote,
  };
}
