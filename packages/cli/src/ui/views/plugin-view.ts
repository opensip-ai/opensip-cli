/**
 * plugin view-model builder — expresses each PluginResult variant
 * (list / add / remove / sync) as a ViewNode.
 */

import { line, group, type Span, type ViewNode } from '@opensip-tools/cli-ui';

import type { PluginInfo, PluginResult, ToolProvenance } from '@opensip-tools/contracts';

const DOMAINS = ['fit', 'sim'] as const;

/** A short, stable prefix of the manifest hash — full hash stays in `--json`. */
function shortHash(manifestHash: string): string {
  return manifestHash.slice(0, 12);
}

function provenanceLine(p: ToolProvenance): ViewNode {
  const spans: Span[] = [
    { text: `    🔧 ${p.id}`, tone: 'brand' },
    { text: ` ${p.version}`, dim: true },
    { text: `  [${p.source}]`, dim: true },
    { text: `  ${shortHash(p.manifestHash)}`, dim: true },
  ];
  if (p.packageName !== undefined) spans.push({ text: `  ${p.packageName}`, dim: true });
  return line(spans);
}

/**
 * Render the admitted-tool provenance recorded this run (release 2.8.0).
 * Additive section below the discovered-plugin list — empty/omitted when
 * no tools were admitted (e.g. no bootstrap, isolated tests).
 */
function provenanceSection(records: readonly ToolProvenance[]): ViewNode[] {
  if (records.length === 0) return [];
  return [
    { kind: 'spacer' },
    line([{ text: 'Tools (provenance)', bold: true }]),
    ...records.map(provenanceLine),
  ];
}

function pluginLine(p: PluginInfo): ViewNode {
  const icon = p.pluginType === 'package' ? '📦' : '📄';
  return line([{ text: `    ${icon} ${p.namespace}` }, { text: ` (${p.pluginType})`, dim: true }]);
}

function domainSection(domain: string, plugins: readonly PluginInfo[]): ViewNode[] {
  const domainPlugins = plugins.filter((p) => p.domain === domain);
  if (domainPlugins.length === 0) {
    return [
      line([
        { text: `  ${domain}/`, dim: true },
        { text: ' — no plugins installed', dim: true },
      ]),
    ];
  }
  return [
    line([
      { text: `  ${domain}/`, tone: 'brand' },
      { text: ` (${domainPlugins.length})`, dim: true },
    ]),
    ...domainPlugins.map(pluginLine),
  ];
}

function listView(
  plugins: readonly PluginInfo[],
  totalCount: number,
  toolProvenance: readonly ToolProvenance[],
): ViewNode {
  const children: ViewNode[] = [
    line([{ text: 'Installed Plugins', bold: true }]),
    { kind: 'spacer' },
    ...DOMAINS.flatMap((domain) => domainSection(domain, plugins)),
  ];
  if (totalCount === 0) {
    children.push(
      { kind: 'spacer' },
      line([
        {
          text: '  No plugins installed. Run opensip-tools plugin add <package> to get started.',
          dim: true,
        },
      ]),
    );
  }
  children.push(...provenanceSection(toolProvenance));
  return group(children);
}

function addRemoveView(
  verb: string,
  failVerb: string,
  packageName: string,
  success: boolean,
  error?: string,
): ViewNode {
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
  synced: readonly {
    readonly domain: string;
    readonly package: string;
    readonly installed: boolean;
  }[],
  success: boolean,
  errors?: readonly string[],
): ViewNode {
  if (synced.length === 0) {
    return group(
      [line([{ text: 'No plugins declared in opensip-tools.config.yml.', dim: true }])],
      2,
    );
  }
  const children: ViewNode[] = [
    line([{ text: 'Plugin sync', bold: true }]),
    ...synced.map((entry) =>
      line([
        { text: entry.installed ? '✔' : '✗', tone: entry.installed ? 'success' : 'error' },
        { text: ' ' },
        { text: `${entry.domain}/`, dim: true },
        { text: entry.package },
      ]),
    ),
  ];
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
      return listView(result.plugins, result.totalCount, result.toolProvenance);
    }
    case 'plugin-add': {
      return addRemoveView(
        'Installed',
        'install',
        result.packageName,
        result.success,
        result.error,
      );
    }
    case 'plugin-remove': {
      return addRemoveView('Removed', 'remove', result.packageName, result.success, result.error);
    }
    case 'plugin-sync': {
      return syncView(result.synced, result.success, result.errors);
    }
  }
}
