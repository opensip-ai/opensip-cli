/**
 * Spinner component — animated progress indicator for long-running tasks.
 * Shows: ⠋ Running checks... Check Name  12/130 (9%)
 */

import { Text } from 'ink';
import React from 'react';

import { useSpinner } from '../hooks/useSpinner.js';
import { useTheme } from '../theme.js';

export interface SpinnerProps {
  readonly total: number;
  readonly completed: number;
  readonly label?: string;
}

export function Spinner({ total, completed, label = 'Running checks...' }: SpinnerProps): React.ReactElement {
  const theme = useTheme();
  const frame = useSpinner();
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <Text>
      <Text color={theme.brand}>{frame}</Text>
      {' '}
      {label}
      {total > 0 ? <Text>  {completed}/{total} ({pct}%)</Text> : null}
    </Text>
  );
}
