/**
 * `opensip config migrate` execution helper.
 */

import { resolve } from 'node:path';

import { migrateConfigFile } from '@opensip-cli/config';
import { PROJECT_CONFIG_FILENAME } from '@opensip-cli/core';

import { createConfigCommandLogger } from './config.js';

import type { ConfigMigrateResult } from '@opensip-cli/contracts';

const CONFIG_MIGRATE_LOG_MODULE = 'cli:config:migrate';

export interface ConfigMigrateInput {
  readonly configPath: string | undefined;
  readonly cwd: string;
  readonly dryRun?: boolean;
  readonly check?: boolean;
}

function resolveConfigPath(input: ConfigMigrateInput): string {
  return input.configPath ?? resolve(input.cwd, PROJECT_CONFIG_FILENAME);
}

export function executeConfigMigrate(input: ConfigMigrateInput): ConfigMigrateResult {
  const log = createConfigCommandLogger();
  const configPath = resolveConfigPath(input);
  const check = input.check === true;
  const dryRun = input.dryRun === true || check;
  log.info({
    evt: 'cli.config.migrate.start',
    module: CONFIG_MIGRATE_LOG_MODULE,
    check,
    dryRun,
  });
  try {
    const migrated = migrateConfigFile({ configPath, dryRun });
    const result: ConfigMigrateResult = {
      type: 'config-migrate',
      configPath,
      changed: migrated.changed,
      dryRun,
      check,
      wrote: migrated.wrote,
      fromVersion: migrated.fromVersion,
      targetVersion: migrated.targetVersion,
      operations: migrated.operations,
    };
    log.info({
      evt: 'cli.config.migrate.complete',
      module: CONFIG_MIGRATE_LOG_MODULE,
      changed: result.changed,
      wrote: result.wrote,
    });
    return result;
  } catch (error) {
    log.error({
      evt: 'cli.config.migrate.error',
      module: CONFIG_MIGRATE_LOG_MODULE,
      err: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
