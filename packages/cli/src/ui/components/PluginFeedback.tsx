/**
 * PluginFeedback component — renders feedback for plugin operations.
 *
 * Consumes `PluginResult` from `@opensip-tools/contracts` directly so
 * producer/consumer drift surfaces at compile time. The previous
 * intermediate `PluginAction` shape (with `'install'` discriminator)
 * is gone; `'add'` is the canonical label.
 */

import { useTheme } from '@opensip-tools/cli-ui';
import { Text, Box } from 'ink';
import React from 'react';


import type { PluginInfo, PluginResult } from '@opensip-tools/contracts';

export interface PluginFeedbackProps {
  readonly result: PluginResult;
}

export function PluginFeedback({ result }: PluginFeedbackProps): React.ReactElement {
  switch (result.type) {
    case 'plugin-list': {
      return <ListView plugins={result.plugins} totalCount={result.totalCount} />;
    }
    case 'plugin-add': {
      return <SuccessOrFailureLine verb="Installed" failVerb="install" packageName={result.packageName} success={result.success} error={result.error} />;
    }
    case 'plugin-remove': {
      return <SuccessOrFailureLine verb="Removed" failVerb="remove" packageName={result.packageName} success={result.success} error={result.error} />;
    }
    case 'plugin-sync': {
      return <SyncView synced={result.synced} success={result.success} errors={result.errors} />;
    }
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function ListView({
  plugins,
  totalCount,
}: Readonly<{ plugins: readonly PluginInfo[]; totalCount: number }>): React.ReactElement {
  const theme = useTheme();
  const byDomain = new Map<string, PluginInfo[]>();
  for (const plugin of plugins) {
    const list = byDomain.get(plugin.domain) ?? [];
    list.push(plugin);
    byDomain.set(plugin.domain, list);
  }

  const domains = ['fit', 'sim'] as const;

  return (
    <Box flexDirection="column">
      <Text bold>Installed Plugins</Text>
      <Text> </Text>
      {domains.map((domain) => {
        const domainPlugins = byDomain.get(domain);
        if (!domainPlugins || domainPlugins.length === 0) {
          return (
            <Text key={domain}>
              {'  '}
              <Text dimColor>{domain}/</Text>
              {' '}
              <Text dimColor>{'—'} no plugins installed</Text>
            </Text>
          );
        }
        return (
          <Box key={domain} flexDirection="column">
            <Text>
              {'  '}
              <Text color={theme.brand}>{domain}/</Text>
              {' '}
              <Text dimColor>({domainPlugins.length})</Text>
            </Text>
            {domainPlugins.map((p) => {
              const icon = p.pluginType === 'package' ? '📦' : '📄';
              return (
                <Text key={p.namespace}>
                  {'    '}
                  {icon} {p.namespace}
                  {' '}
                  <Text dimColor>({p.pluginType})</Text>
                </Text>
              );
            })}
          </Box>
        );
      })}
      {totalCount === 0 && (
        <Box flexDirection="column">
          <Text> </Text>
          <Text dimColor>
            {'  '}No plugins installed. Run opensip-tools plugin add {'<package>'} to get started.
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// add / remove
// ---------------------------------------------------------------------------

function SuccessOrFailureLine({
  verb,
  failVerb,
  packageName,
  success,
  error,
}: Readonly<{
  verb: string;
  failVerb: string;
  packageName: string;
  success: boolean;
  error?: string;
}>): React.ReactElement {
  const theme = useTheme();
  if (success) {
    return (
      <Box paddingLeft={2}>
        <Text>
          <Text color={theme.success}>{'✔'}</Text>
          {' '}
          {verb} {packageName}
        </Text>
      </Box>
    );
  }
  return (
    <Box paddingLeft={2}>
      <Text>
        <Text color={theme.error}>{'✗'}</Text>
        {' '}
        Failed to {failVerb} {packageName}
        {error && <Text dimColor> ({error})</Text>}
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

function SyncView({
  synced,
  success,
  errors,
}: Readonly<{
  synced: readonly { domain: string; package: string; installed: boolean }[];
  success: boolean;
  errors?: readonly string[];
}>): React.ReactElement {
  const theme = useTheme();
  if (synced.length === 0) {
    return (
      <Box paddingLeft={2}>
        <Text dimColor>No plugins declared in opensip-tools.config.yml.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text bold>Plugin sync</Text>
      {synced.map((entry, i) => (
        <Text key={`${entry.domain}/${entry.package}/${String(i)}`}>
          <Text color={entry.installed ? theme.success : theme.error}>
            {entry.installed ? '✔' : '✗'}
          </Text>
          {' '}
          <Text dimColor>{entry.domain}/</Text>
          {entry.package}
        </Text>
      ))}
      {errors && errors.length > 0 && (
        <Box flexDirection="column" paddingTop={1}>
          {errors.map((message, i) => (
            <Text key={`err-${String(i)}`} color={theme.error}>{message}</Text>
          ))}
        </Box>
      )}
      <Box paddingTop={1}>
        <Text>
          {success ? (
            <Text color={theme.success}>All plugins synced successfully.</Text>
          ) : (
            <Text color={theme.error}>One or more plugins failed to install.</Text>
          )}
        </Text>
      </Box>
    </Box>
  );
}
