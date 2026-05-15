/**
 * InitFeedback component — renders feedback for the init command.
 *
 * Branches:
 *   - ambiguous language detection (exit 2 with prompt)
 *   - already-exists (refuse without --force)
 *   - successful scaffold (list created files + the smoke-test command)
 *   - fallback (creation failed)
 */

import { Text, Box } from 'ink';
import React from 'react';

import { useTheme } from '../theme.js';

export interface InitFeedbackProps {
  readonly created: boolean;
  readonly path: string;
  readonly alreadyExists: boolean;
  readonly cwd: string;
  readonly configFilename: string;
  readonly languages?: readonly string[];
  readonly createdFiles?: readonly string[];
  readonly gitignoreUpdated?: boolean;
  readonly ambiguousLanguageError?: {
    readonly detected: readonly string[];
    readonly message: string;
  };
}

export function InitFeedback(props: InitFeedbackProps): React.ReactElement {
  const theme = useTheme();
  const { created, alreadyExists, cwd, configFilename, languages, createdFiles, gitignoreUpdated, ambiguousLanguageError } = props;

  if (ambiguousLanguageError) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text>
          <Text color={theme.error}>{'✗'}</Text>
          {' '}
          <Text bold>Cannot scaffold — language ambiguous</Text>
        </Text>
        <Text> </Text>
        <Text>{'  '}{ambiguousLanguageError.message}</Text>
      </Box>
    );
  }

  if (alreadyExists) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text>
          <Text color={theme.warning}>{'⚠'}</Text>
          {' '}
          {configFilename} already exists in <Text dimColor>{cwd}</Text>
        </Text>
        <Text dimColor>{'  '}Re-run with <Text bold>--force</Text> to overwrite.</Text>
      </Box>
    );
  }

  if (created) {
    const langDisplay = languages && languages.length > 0 ? languages.join(', ') : 'unknown';
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text>
          <Text color={theme.success}>{'✓'}</Text>
          {' '}
          Scaffolded for <Text bold>{langDisplay}</Text> in <Text dimColor>{cwd}</Text>
        </Text>
        {createdFiles && createdFiles.length > 0 && (
          <Box flexDirection="column" paddingTop={1}>
            {createdFiles.map((f) => (
              <Text key={f} dimColor>{'    '}{relativize(f, cwd)}</Text>
            ))}
          </Box>
        )}
        {gitignoreUpdated && (
          <Text dimColor>{'    '}.gitignore (added opensip-tools/.runtime/)</Text>
        )}
        <Text> </Text>
        <Text dimColor>{'  '}Try it:</Text>
        <Text>{'    '}<Text color={theme.brand}>opensip-tools fit --recipe example</Text></Text>
        <Text>{'    '}<Text color={theme.brand}>opensip-tools sim --recipe example</Text></Text>
      </Box>
    );
  }

  return (
    <Box paddingLeft={2}>
      <Text>
        <Text color={theme.error}>{'✗'}</Text>
        {' '}
        Failed to scaffold {configFilename} at <Text dimColor>{props.path}</Text>
      </Text>
    </Box>
  );
}

/** Display a path relative to cwd when it's underneath, otherwise absolute. */
function relativize(p: string, cwd: string): string {
  if (p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1);
  return p;
}
