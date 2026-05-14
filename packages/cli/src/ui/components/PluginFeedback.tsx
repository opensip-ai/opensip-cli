/**
 * PluginFeedback component — renders feedback for plugin operations.
 */

import { Text, Box } from 'ink';
import React from 'react';

import { useTheme } from '../theme.js';

export type PluginAction =
  | { readonly type: 'list'; readonly plugins: readonly PluginInfo[]; readonly totalCount: number }
  | { readonly type: 'install'; readonly packageName: string; readonly success: boolean; readonly error?: string }
  | { readonly type: 'remove'; readonly packageName: string; readonly success: boolean; readonly error?: string };

interface PluginInfo {
  readonly domain: string;
  readonly namespace: string;
  readonly pluginType: 'package' | 'file';
}

export interface PluginFeedbackProps {
  readonly action: PluginAction;
}

export function PluginFeedback({ action }: PluginFeedbackProps): React.ReactElement {
  const theme = useTheme();

  if (action.type === 'list') {
    // Group by domain
    const byDomain = new Map<string, PluginInfo[]>();
    for (const plugin of action.plugins) {
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
          const plugins = byDomain.get(domain);
          if (!plugins || plugins.length === 0) {
            return (
              <Text key={domain}>
                {'  '}
                <Text dimColor>{domain}/</Text>
                {' '}
                <Text dimColor>{'\u2014'} no plugins installed</Text>
              </Text>
            );
          }
          return (
            <Box key={domain} flexDirection="column">
              <Text>
                {'  '}
                <Text color={theme.brand}>{domain}/</Text>
                {' '}
                <Text dimColor>({plugins.length})</Text>
              </Text>
              {plugins.map((p) => {
                const icon = p.pluginType === 'package' ? '\uD83D\uDCE6' : '\uD83D\uDCC4';
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
        {action.totalCount === 0 && (
          <Box flexDirection="column">
            <Text> </Text>
            <Text dimColor>
              {'  '}No plugins installed. Run opensip-tools plugin install {'<package>'} to get started.
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  if (action.type === 'install') {
    if (action.success) {
      return (
        <Box paddingLeft={2}>
          <Text>
            <Text color={theme.success}>{'\u2714'}</Text>
            {' '}
            Installed {action.packageName}
          </Text>
        </Box>
      );
    }
    return (
      <Box paddingLeft={2}>
        <Text>
          <Text color={theme.error}>{'\u2717'}</Text>
          {' '}
          Failed to install {action.packageName}
          {action.error && <Text dimColor> ({action.error})</Text>}
        </Text>
      </Box>
    );
  }

  // action.type === 'remove'
  if (action.success) {
    return (
      <Box paddingLeft={2}>
        <Text>
          <Text color={theme.success}>{'\u2714'}</Text>
          {' '}
          Removed {action.packageName}
        </Text>
      </Box>
    );
  }
  return (
    <Box paddingLeft={2}>
      <Text>
        <Text color={theme.error}>{'\u2717'}</Text>
        {' '}
        Failed to remove {action.packageName}
        {action.error && <Text dimColor> ({action.error})</Text>}
      </Text>
    </Box>
  );
}
