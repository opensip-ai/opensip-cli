/**
 * plugin view-model builder — expresses each PluginResult variant
 * (list / add / remove / sync) as a ViewNode.
 */

import { line, group, type Span, type ViewNode } from '@opensip-tools/cli-ui';

import type { PluginInfo, PluginResult } from '@opensip-tools/contracts';

const DOMAINS = ['fit', 'sim'] as const;

function listView(plugins: readonly PluginInfo[], totalCount: number): ViewNode {
  const byDomain = new Map<string, PluginInfo[]>();
  for (const p of plugins) {
    const list = byDomain.get(p.domain) ?? [];
    list.push(p);
    byDomain.set(p.domain, list);
  }

  const children: ViewNode[] = [line([{ text: 'Installed Plugins', bold: true }]), { kind: 'spacer' }];

  for (const domain of DOMAINS) {
    const domainPlugins = byDomain.get(domain);
    if (domainPlugins === undefined || domainPlugins.length === 0) {
      children.push(line([{ text: `  ${domain}/`, dim: true }, { text: ' — no plugins installed', dim: true }]));
      continue;
    }
    children.push(line([{ text: `  ${domain}/`, tone: 'brand' }, { text: ` (${domainPlugins.length})`, dim: true }]));
    for (const p of domainPlugins) {
      const icon = p.pluginType === 'package' ? '📦' : '📄';
      children.push(line([{ text: `    ${icon} ${p.namespace}` }, { text: ` (${p.pluginType})`, dim: true }]));
    }
  }

  if (totalCount === 0) {
    children.push(
      { kind: 'spacer' },
      line([{ text: '  No plugins installed. Run opensip-tools plugin add <package> to get started.', dim: true }]),
    );
  }
  return group(children);
}

function addRemoveView(verb: string, failVerb: string, packageName: string, success: boolean, error?: string): ViewNode {
  if (success) {
    return group([line([{ text: '✔', tone: 'success' }, { text: ` ${verb} ${packageName}` }])], 2);
  }
  const spans: Span[] = [
    { text: '✗', tone: 'error' },
    { text: ` Failed to ${failVerb} ${packageName}` },
  ];
  if (error !== undefined) spans.push({ text: ` (${error})`, dim: true });
  return group([line(spans)], 2);
}

function syncView(
  synced: readonly { readonly domain: string; readonly package: string; readonly installed: boolean }[],
  success: boolean,
  errors?: readonly string[],
): ViewNode {
  if (synced.length === 0) {
    return group([line([{ text: 'No plugins declared in opensip-tools.config.yml.', dim: true }])], 2);
  }
  const children: ViewNode[] = [line([{ text: 'Plugin sync', bold: true }])];
  for (const entry of synced) {
    children.push(
      line([
        { text: entry.installed ? '✔' : '✗', tone: entry.installed ? 'success' : 'error' },
        { text: ' ' },
        { text: `${entry.domain}/`, dim: true },
        { text: entry.package },
      ]),
    );
  }
  if (errors && errors.length > 0) {
    children.push({ kind: 'spacer' }, ...errors.map((m) => line([{ text: m, tone: 'error' }])));
  }
  children.push(
    { kind: 'spacer' },
    success
      ? line([{ text: 'All plugins synced successfully.', tone: 'success' }])
      : line([{ text: 'One or more plugins failed to install.', tone: 'error' }]),
  );
  return group(children, 2);
}

export function viewPlugin(result: PluginResult): ViewNode {
  switch (result.type) {
    case 'plugin-list': {
      return listView(result.plugins, result.totalCount);
    }
    case 'plugin-add': {
      return addRemoveView('Installed', 'install', result.packageName, result.success, result.error);
    }
    case 'plugin-remove': {
      return addRemoveView('Removed', 'remove', result.packageName, result.success, result.error);
    }
    case 'plugin-sync': {
      return syncView(result.synced, result.success, result.errors);
    }
  }
}
