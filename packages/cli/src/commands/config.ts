/**
 * `opensip config validate|schema` execution helpers.
 */

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  analyzeNamespaceClaims,
  composeConfigSchema,
  toJsonSchema,
  validateConfigDocument,
  type ToolConfigDeclaration,
} from '@opensip-cli/config';
import {
  ConfigurationError,
  currentScope,
  readYamlFileOrThrow,
  type ToolPluginManifest,
  type ToolProvenance,
  type ToolRegistry,
} from '@opensip-cli/core';

import { buildConfigDeclarations } from '../bootstrap/config-declarations.js';

import type { ConfigSchemaResult, ConfigValidateResult } from '@opensip-cli/contracts';

const CONFIG_LOG_MODULE = 'cli:config';

export interface ConfigValidateInput {
  readonly tools: ToolRegistry;
  readonly manifests?: readonly ToolPluginManifest[];
  readonly provenance?: readonly ToolProvenance[];
  readonly configPath: string | undefined;
  readonly cwd: string;
}

export interface ConfigSchemaInput extends ConfigValidateInput {
  readonly outPath?: string;
}

function configLogger(): {
  readonly info: (entry: Record<string, unknown>) => void;
  readonly error: (entry: Record<string, unknown>) => void;
} {
  const logger = currentScope()?.logger;
  return {
    info: (entry) => {
      logger?.info(entry);
    },
    error: (entry) => {
      logger?.error(entry);
    },
  };
}

function readConfigDocument(configPath: string | undefined): unknown {
  if (configPath === undefined) return {};
  return readYamlFileOrThrow(configPath, { loader: 'project-config' });
}

function namespaceNames(declarations: readonly ToolConfigDeclaration[]): readonly string[] {
  return [...new Set(declarations.map((d) => d.namespace))].sort();
}

function collectWarnings(
  declarations: readonly ToolConfigDeclaration[],
  document: unknown,
): readonly string[] {
  const report = analyzeNamespaceClaims(declarations, document);
  return report.unclaimed.map((u) => {
    const didYouMean = u.suggestion === undefined ? '' : ` — did you mean '${u.suggestion}:'?`;
    return `Config namespace '${u.namespace}:' is not claimed by any loaded tool${didYouMean}`;
  });
}

export function executeConfigValidate(input: ConfigValidateInput): ConfigValidateResult {
  const log = configLogger();
  log.info({ evt: 'cli.config.validate.start', module: CONFIG_LOG_MODULE });
  try {
    const { declarations } = buildConfigDeclarations({
      tools: input.tools,
      manifests: input.manifests,
      provenance: input.provenance,
    });
    const schema = composeConfigSchema(declarations);
    const document = readConfigDocument(input.configPath);
    validateConfigDocument(schema, document);
    const warnings = collectWarnings(declarations, document);
    const configPath = input.configPath ?? resolve(input.cwd, 'opensip-cli.config.yml');
    const result: ConfigValidateResult = {
      type: 'config-validate',
      valid: true,
      configPath,
      namespaces: namespaceNames(declarations),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    log.info({
      evt: 'cli.config.validate.complete',
      module: CONFIG_LOG_MODULE,
      namespaces: result.namespaces.length,
    });
    return result;
  } catch (error) {
    log.error({
      evt: 'cli.config.validate.error',
      module: CONFIG_LOG_MODULE,
      err: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * @throws {ConfigurationError} When `--out` points to a directory.
 * @throws {Error} When schema composition or file write fails.
 */
export function executeConfigSchema(input: ConfigSchemaInput): ConfigSchemaResult {
  const log = configLogger();
  log.info({ evt: 'cli.config.schema.start', module: CONFIG_LOG_MODULE });
  try {
    const { declarations } = buildConfigDeclarations({
      tools: input.tools,
      manifests: input.manifests,
      provenance: input.provenance,
    });
    const schema = toJsonSchema(composeConfigSchema(declarations));
    const namespaces = namespaceNames(declarations);
    let outPath: string | undefined;
    if (input.outPath !== undefined) {
      const resolved = resolve(input.cwd, input.outPath);
      let stat;
      try {
        stat = statSync(resolved);
      } catch {
        stat = undefined;
      }
      if (stat?.isDirectory()) {
        throw new ConfigurationError(`--out must be a file path, not a directory: '${resolved}'`);
      }
      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
      outPath = resolved;
    }
    const result: ConfigSchemaResult = {
      type: 'config-schema',
      schema,
      namespaces,
      ...(outPath === undefined ? {} : { outPath }),
    };
    log.info({
      evt: 'cli.config.schema.complete',
      module: CONFIG_LOG_MODULE,
      namespaces: namespaces.length,
      wroteFile: outPath !== undefined,
    });
    return result;
  } catch (error) {
    log.error({
      evt: 'cli.config.schema.error',
      module: CONFIG_LOG_MODULE,
      err: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
