/**
 * CheckList component — renders available fitness checks grouped by tag.
 */

import { useTheme } from '@opensip-tools/cli-ui';
import { Text, Box } from 'ink';
import React from 'react';


interface CheckEntry {
  readonly slug: string;
  readonly description: string;
  readonly tags: readonly string[];
}

export interface CheckListProps {
  readonly checks: readonly CheckEntry[];
  readonly totalCount: number;
}

export function CheckList({ checks, totalCount }: CheckListProps): React.ReactElement {
  const theme = useTheme();

  // Group by tag
  const tagGroups = new Map<string, CheckEntry[]>();
  for (const check of checks) {
    const tags = check.tags.length > 0 ? check.tags : ['untagged'];
    for (const tag of tags) {
      const list = tagGroups.get(tag) ?? [];
      list.push(check);
      tagGroups.set(tag, list);
    }
  }

  // Sort tags alphabetically
  const sortedTags = [...tagGroups.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>Available Fitness Checks</Text>
        {' '}
        <Text dimColor>({totalCount} total)</Text>
      </Text>
      <Text> </Text>
      {sortedTags.map(([tag, tagChecks]) => {
        const sorted = [...tagChecks].sort((a, b) => a.slug.localeCompare(b.slug));
        return (
          <Box key={tag} flexDirection="column" marginLeft={2}>
            <Text>
              <Text color={theme.brand}>{tag}</Text>
              {' '}
              <Text dimColor>({tagChecks.length})</Text>
            </Text>
            {sorted.map((check) => (
              <Text key={check.slug}>
                {'    '}
                {check.slug}
                {' '}
                <Text dimColor>{'\u2014'} {check.description}</Text>
              </Text>
            ))}
            <Text> </Text>
          </Box>
        );
      })}
    </Box>
  );
}
