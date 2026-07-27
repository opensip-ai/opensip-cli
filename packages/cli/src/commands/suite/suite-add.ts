// @fitness-ignore-file dogfood-one-config-document-ratchet -- `suite add` is the host-owned config authoring command: it intentionally edits opensip-cli.config.yml and does not participate in runtime config loading.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { isReservedSuiteName, reservedSuiteNameMessage } from '@opensip-cli/config';
import { ConfigurationError, currentLogger, type Tool } from '@opensip-cli/core';
import { isMap, isSeq, parseDocument, type Document as YAMLDocument, type YAMLMap } from 'yaml';

import { hostErrorCatalog } from '../../errors/host-error-catalog.js';

// Plan 01 clean break: registered host definitions replace bare code literals that only
// resolved through legacyFamilyCode's head-guessing.
const SUITE_EDIT_REFUSED = hostErrorCatalog.require('CLI.SUITE.EDIT_REFUSED');
const SUITE_INVALID = hostErrorCatalog.require('CLI.SUITE.INVALID');
const SUITE_UNKNOWN_REFERENCE = hostErrorCatalog.require('CLI.SUITE.UNKNOWN_REFERENCE');

const MAX_EDITABLE_CONFIG_BYTES = 1_000_000;

export interface SuiteAddInput {
  readonly suite: string;
  readonly tool: string;
  readonly command: string;
  readonly argPairs: readonly string[];
  readonly tools: readonly Tool[];
  readonly projectRoot: string;
  readonly configPath?: string;
}

export interface SuiteAddOutput {
  readonly configPath: string;
  readonly changed: boolean;
  readonly tool: Tool;
  readonly args: Readonly<Record<string, unknown>>;
}

export function addSuiteStep(input: SuiteAddInput): SuiteAddOutput {
  // ADR-0159: refuse before any YAML edit — `suite add` must never author a
  // config the document schema then rejects on every subsequent command.
  if (isReservedSuiteName(input.suite)) {
    throw new ConfigurationError(reservedSuiteNameMessage(input.suite), {
      code: SUITE_INVALID.code,
      definition: SUITE_INVALID,
      metadata: { condition: 'reserved-name' },
    });
  }
  const tool = resolveTool(input.tool, input.tools);
  const command = tool.commandSpecs?.find((spec) => spec.name === input.command);
  if (command === undefined) {
    throw new ConfigurationError(
      `Tool '${tool.metadata.name}' has no command '${input.command}'.`,
      {
        code: SUITE_UNKNOWN_REFERENCE.code,
        definition: SUITE_UNKNOWN_REFERENCE,
        metadata: { condition: 'unknown-command' },
      },
    );
  }
  const configPath = input.configPath ?? join(input.projectRoot, 'opensip-cli.config.yml');
  const args = parseArgPairs(input.argPairs);
  const changed = appendSuiteStep(configPath, input.suite, {
    tool: tool.metadata.id,
    name: tool.metadata.name,
    command: command.name,
    ...(Object.keys(args).length === 0 ? {} : { args }),
  });
  return { configPath, changed, tool, args };
}

function resolveTool(selector: string, tools: readonly Tool[]): Tool {
  const matches = tools.filter(
    (tool) => tool.metadata.id === selector || tool.metadata.name === selector,
  );
  if (matches.length === 1) {
    const [match] = matches;
    if (match !== undefined) return match;
  }
  if (matches.length > 1) {
    throw new ConfigurationError(
      `Tool selector '${selector}' matched multiple tools. Use a UUID.`,
      {
        code: SUITE_UNKNOWN_REFERENCE.code,
        definition: SUITE_UNKNOWN_REFERENCE,
        metadata: { condition: 'ambiguous-tool' },
      },
    );
  }
  throw new ConfigurationError(`Unknown tool '${selector}'.`, {
    code: SUITE_UNKNOWN_REFERENCE.code,
    definition: SUITE_UNKNOWN_REFERENCE,
    metadata: { condition: 'unknown-tool' },
  });
}

function parseArgPairs(pairs: readonly string[]): Readonly<Record<string, unknown>> {
  const args: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new ConfigurationError(`Invalid --arg '${pair}'. Expected key=value.`, {
        code: SUITE_INVALID.code,
        definition: SUITE_INVALID,
        metadata: { condition: 'invalid-arg' },
      });
    }
    args[pair.slice(0, eq)] = parseScalar(pair.slice(eq + 1));
  }
  return args;
}

function parseScalar(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function appendSuiteStep(
  configPath: string,
  suiteName: string,
  step: Readonly<Record<string, unknown>>,
): boolean {
  const doc = readOrCreateDocument(configPath);
  const root = ensureRootMap(doc, configPath);
  let suites = root.get('suites');
  if (suites === undefined) {
    suites = doc.createNode({});
    root.set('suites', suites);
  } else if (!isMap(suites)) {
    throw new ConfigurationError(`Cannot edit suites in ${configPath}.`, {
      code: SUITE_EDIT_REFUSED.code,
      definition: SUITE_EDIT_REFUSED,
      metadata: { condition: 'suites-block' },
    });
  }
  const suitesMap = suites as YAMLMap;
  let suite = suitesMap.get(suiteName);
  if (suite === undefined) {
    suite = doc.createNode({ steps: [] });
    suitesMap.set(suiteName, suite);
  } else if (!isMap(suite)) {
    throw new ConfigurationError(`Cannot edit suites.${suiteName} in ${configPath}.`, {
      code: SUITE_EDIT_REFUSED.code,
      definition: SUITE_EDIT_REFUSED,
      metadata: { condition: 'suite-block' },
    });
  }
  const suiteMap = suite as YAMLMap;
  let seq = suiteMap.get('steps');
  if (seq === undefined) {
    seq = doc.createNode([]);
    suiteMap.set('steps', seq);
  }
  if (!isSeq(seq)) {
    throw new ConfigurationError(`Cannot edit suites.${suiteName}.steps in ${configPath}.`, {
      code: SUITE_EDIT_REFUSED.code,
      definition: SUITE_EDIT_REFUSED,
      metadata: { condition: 'steps-block' },
    });
  }
  const yamlSeq = seq;
  if (
    yamlSeq.items.some((item) =>
      isDeepStrictEqual(normalizeSignedZero(yamlNodeToJson(item)), normalizeSignedZero(step)),
    )
  ) {
    currentLogger().info?.({
      evt: 'cli.suite.add.duplicate_step',
      suite: suiteName,
      configPath,
      msg: 'Suite step already exists; leaving config unchanged.',
    });
    return false;
  }
  yamlSeq.add(step);
  writeFileSync(configPath, doc.toString(), 'utf8');
  return true;
}

function yamlNodeToJson(item: unknown): unknown {
  if (item && typeof item === 'object' && 'toJSON' in item) {
    return (item as { toJSON(): unknown }).toJSON();
  }
  return item;
}

function normalizeSignedZero(value: unknown): unknown {
  if (typeof value === 'number') return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(normalizeSignedZero);
  if (value === null || typeof value !== 'object') return value;
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, normalizeSignedZero(nested)]),
  );
}

function readOrCreateDocument(configPath: string): YAMLDocument {
  if (!existsSync(configPath)) return parseDocument('');
  const stat = statSync(configPath);
  if (stat.size > MAX_EDITABLE_CONFIG_BYTES) {
    throw new ConfigurationError(
      `Cannot edit ${configPath}: file is larger than ${MAX_EDITABLE_CONFIG_BYTES} bytes.`,
      {
        code: SUITE_EDIT_REFUSED.code,
        definition: SUITE_EDIT_REFUSED,
        metadata: { condition: 'too-large' },
      },
    );
  }
  const doc = parseDocument(readFileSync(configPath, 'utf8'));
  if (doc.errors.length > 0) {
    const first = doc.errors[0]?.message ?? 'unknown YAML error';
    throw new ConfigurationError(`Cannot edit ${configPath}: ${first}.`, {
      code: SUITE_EDIT_REFUSED.code,
      definition: SUITE_EDIT_REFUSED,
      metadata: { condition: 'malformed-yaml' },
    });
  }
  return doc;
}

function ensureRootMap(doc: YAMLDocument, configPath: string): YAMLMap {
  doc.contents ??= doc.createNode({});
  if (!isMap(doc.contents)) {
    throw new ConfigurationError(
      `Cannot edit ${configPath}: opensip-cli.config.yml must start with a YAML map.`,
      {
        code: SUITE_EDIT_REFUSED.code,
        definition: SUITE_EDIT_REFUSED,
        metadata: { condition: 'non-map' },
      },
    );
  }
  return doc.contents;
}
