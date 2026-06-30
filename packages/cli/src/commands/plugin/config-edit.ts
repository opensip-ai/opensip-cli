/**
 * @fileoverview YAML-driven edits to `plugins.<domain>` in
 * `opensip-cli.config.yml`.
 *
 * Extracted from `commands/plugin.ts` to keep that module focused on
 * Commander wiring + the npm install/uninstall flows. The Document API
 * round-trips comments, ordering, and whitespace; a malformed document
 * fails closed so the caller surfaces a clear error.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import {
  parseDocument,
  isMap,
  isScalar,
  isSeq,
  type Document as YAMLDocument,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';

/**
 * Edit the project's `plugins.<domain>` list. Returns true when the
 * file was changed.
 *
 * @throws Error when the YAML document is malformed or its root is not
 *   a mapping. The caller surfaces a "your config is broken" message.
 */
export function editPluginList(
  configPath: string,
  domain: string,
  name: string,
  op: 'add' | 'remove',
): boolean {
  if (!existsSync(configPath)) {
    if (op === 'remove') return false;
    // No config to edit — write a minimal one.
    writeFileSync(configPath, `plugins:\n  ${domain}:\n    - "${name}"\n`, 'utf8');
    return true;
  }

  const text = readFileSync(configPath, 'utf8');
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    const first = doc.errors[0]?.message ?? 'unknown YAML error';
    throw new Error(
      `Cannot edit plugins.${domain} in ${configPath}: ${first}. ` +
        `Fix the syntax error and re-run.`,
    );
  }

  const root = doc.contents;
  if (root === null) {
    if (op === 'remove') return false;
    // Empty doc — write a fresh `plugins:` map.
    writeFileSync(configPath, `plugins:\n  ${domain}:\n    - "${name}"\n`, 'utf8');
    return true;
  }

  // The top-level node must be a YAML map. A scalar / sequence at
  // the root means the file isn't an opensip-cli config — refuse
  // to edit rather than reformat the whole thing.
  if (!isMap(root)) {
    throw new Error(
      `Cannot edit plugins.${domain} in ${configPath}: top-level node is not a mapping. ` +
        `opensip-cli.config.yml must start with a YAML map.`,
    );
  }

  if (op === 'add') {
    return appendToPluginList(doc, root, domain, name, configPath);
  }
  return removeFromPluginList(doc, root, domain, name, configPath);
}

function appendToPluginList(
  doc: YAMLDocument,
  root: YAMLMap,
  domain: string,
  name: string,
  configPath: string,
): boolean {
  let plugins = root.get('plugins');
  if (!isMap(plugins)) {
    plugins = doc.createNode({});
    root.set('plugins', plugins);
  }
  const pluginsMap = plugins as YAMLMap;

  let list = pluginsMap.get(domain);
  if (!isSeq(list)) {
    list = doc.createNode([]);
    pluginsMap.set(domain, list);
  }
  const seq = list as YAMLSeq;

  // Idempotent — first occurrence wins.
  for (const item of seq.items) {
    const value = isScalar(item) ? item.value : item;
    if (value === name) return false;
  }
  seq.add(name);
  writeFileSync(configPath, doc.toString(), 'utf8');
  return true;
}

function removeFromPluginList(
  doc: YAMLDocument,
  root: YAMLMap,
  domain: string,
  name: string,
  configPath: string,
): boolean {
  const plugins = root.get('plugins');
  if (!isMap(plugins)) return false;
  const list = plugins.get(domain);
  if (!isSeq(list)) return false;

  const before = list.items.length;
  list.items = list.items.filter((item) => {
    const value = isScalar(item) ? item.value : item;
    return value !== name;
  });
  if (list.items.length === before) return false;
  writeFileSync(configPath, doc.toString(), 'utf8');
  return true;
}

export function addToConfigPluginList(configPath: string, domain: string, name: string): boolean {
  return editPluginList(configPath, domain, name, 'add');
}

export function removeFromConfigPluginList(
  configPath: string,
  domain: string,
  name: string,
): boolean {
  return editPluginList(configPath, domain, name, 'remove');
}
