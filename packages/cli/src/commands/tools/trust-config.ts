// @fitness-ignore-file dogfood-one-config-document-ratchet -- `tools create` is a host-owned config authoring command: it intentionally edits tools.trusted in opensip-cli.config.yml and does not participate in runtime config loading.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

import { ConfigurationError } from '@opensip-cli/core';
import {
  parseDocument,
  isMap,
  isScalar,
  isSeq,
  type Document as YAMLDocument,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';

import { hostErrorCatalog } from '../../errors/host-error-catalog.js';

const EDIT_REFUSED = hostErrorCatalog.require('CLI.TOOLS.EDIT_REFUSED');

const MAX_EDITABLE_CONFIG_BYTES = 1_000_000;

/**
 * Add a tool id to top-level `tools.trusted` in opensip-cli.config.yml.
 *
 * @throws {ConfigurationError} When the config file is malformed, too large, or has an
 * incompatible shape for `tools.trusted`.
 */
export function addTrustedToolToConfig(configPath: string, toolId: string): boolean {
  if (!existsSync(configPath)) {
    writeFileSync(configPath, `tools:\n  trusted:\n    - "${toolId}"\n`, 'utf8');
    return true;
  }

  const stats = statSync(configPath);
  if (stats.size > MAX_EDITABLE_CONFIG_BYTES) {
    throw new ConfigurationError(
      `Cannot edit tools.trusted in ${configPath}: file is larger than ${MAX_EDITABLE_CONFIG_BYTES} bytes.`,
      {
        code: EDIT_REFUSED.code,
        definition: EDIT_REFUSED,
        metadata: { condition: 'too-large', path: configPath },
      },
    );
  }
  const text = readFileSync(configPath, 'utf8');
  const doc: YAMLDocument = parseDocument(text);
  if (doc.errors.length > 0) {
    const first = doc.errors[0]?.message ?? 'unknown YAML error';
    throw new ConfigurationError(
      `Cannot edit tools.trusted in ${configPath}: ${first}. Fix the syntax error and re-run.`,
      {
        code: EDIT_REFUSED.code,
        definition: EDIT_REFUSED,
        metadata: { condition: 'malformed-yaml', path: configPath },
      },
    );
  }

  const root = doc.contents;
  if (root === null) {
    writeFileSync(configPath, `tools:\n  trusted:\n    - "${toolId}"\n`, 'utf8');
    return true;
  }
  if (!isMap(root)) {
    throw new ConfigurationError(
      `Cannot edit tools.trusted in ${configPath}: top-level node is not a mapping. ` +
        `opensip-cli.config.yml must start with a YAML map.`,
      {
        code: EDIT_REFUSED.code,
        definition: EDIT_REFUSED,
        metadata: { condition: 'non-map', path: configPath },
      },
    );
  }

  let tools = root.get('tools');
  if (tools === undefined) {
    tools = doc.createNode({});
    root.set('tools', tools);
  } else if (!isMap(tools)) {
    throw new ConfigurationError(
      `Cannot edit tools.trusted in ${configPath}: tools must be a mapping.`,
      {
        code: EDIT_REFUSED.code,
        definition: EDIT_REFUSED,
        metadata: { condition: 'tools-not-map', path: configPath },
      },
    );
  }
  const toolsMap = tools as YAMLMap;

  let trusted = toolsMap.get('trusted');
  if (trusted === undefined) {
    trusted = doc.createNode([]);
    toolsMap.set('trusted', trusted);
  } else if (!isSeq(trusted)) {
    throw new ConfigurationError(
      `Cannot edit tools.trusted in ${configPath}: tools.trusted must be a sequence.`,
      {
        code: EDIT_REFUSED.code,
        definition: EDIT_REFUSED,
        metadata: { condition: 'trusted-not-seq', path: configPath },
      },
    );
  }
  const seq = trusted as YAMLSeq;

  const alreadyTrusted = seq.items.some((item) => {
    const value = isScalar(item) ? item.value : item;
    return value === toolId;
  });
  const changed = !alreadyTrusted;
  if (changed) {
    seq.add(toolId);
    writeFileSync(configPath, doc.toString(), 'utf8');
  }
  return changed;
}
