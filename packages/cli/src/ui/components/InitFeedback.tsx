/**
 * InitFeedback component — renders feedback for the init command.
 *
 * Branches:
 *   - ambiguous language detection (exit 2 with prompt)
 *   - partial-state refusal (exit 2 with file list + flag hint)
 *   - re-scaffold success (state === 'fully-initialized' / partial-*)
 *   - successful pristine scaffold (list created files + the smoke-test command)
 *   - fallback (creation failed)
 */

import { useTheme } from '@opensip-tools/cli-ui';
import { Text, Box } from 'ink';
import React from 'react';


import type { PreExistingFile } from '@opensip-tools/contracts';

export interface InitFeedbackProps {
  readonly created: boolean;
  readonly path: string;
  readonly cwd: string;
  readonly configFilename: string;
  readonly state?: 'pristine' | 'fully-initialized' | 'partial-config-only' | 'partial-dir-only';
  readonly languages?: readonly string[];
  readonly createdFiles?: readonly string[];
  readonly gitignoreUpdated?: boolean;
  readonly preExistingFiles?: readonly PreExistingFile[];
  readonly partialStateError?: {
    readonly state: 'partial-config-only' | 'partial-dir-only' | 'fully-initialized';
    readonly preExistingFiles: readonly PreExistingFile[];
    readonly message: string;
  };
  readonly ambiguousLanguageError?: {
    readonly detected: readonly string[];
    readonly message: string;
  };
}

export function InitFeedback(props: InitFeedbackProps): React.ReactElement {
  const theme = useTheme();
  const { created, state, cwd, configFilename, languages, createdFiles, gitignoreUpdated, preExistingFiles, partialStateError, ambiguousLanguageError } = props;

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

  if (partialStateError) {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text>
          <Text color={theme.warning}>{'⚠'}</Text>
          {' '}
          <Text bold>{headlineForPartialState(partialStateError.state, configFilename)}</Text>
          {' '}in <Text dimColor>{cwd}</Text>
        </Text>
        {partialStateError.preExistingFiles.length > 0 && (
          <Box flexDirection="column" paddingTop={1}>
            <Text dimColor>{'  '}Found {partialStateError.preExistingFiles.length} file(s) under opensip-tools/:</Text>
            {partialStateError.preExistingFiles.map((f) => (
              <Text key={f.path}>
                {'    '}
                <Text dimColor>{relativize(f.path, cwd)}</Text>
                {'  '}
                <Text color={classificationColor(f.classification, theme)}>({f.classification})</Text>
              </Text>
            ))}
          </Box>
        )}
        <Text> </Text>
        <Text>{'  '}Choose one:</Text>
        <Text>{'    '}<Text color={theme.brand}>opensip-tools init --keep</Text>{'    '}<Text dimColor>Re-scaffold examples; preserve custom files.</Text></Text>
        <Text>{'    '}<Text color={theme.brand}>opensip-tools init --remove</Text>{'  '}<Text dimColor>Delete opensip-tools/ and scaffold fresh.</Text></Text>
      </Box>
    );
  }

  if (created) {
    const langDisplay = languages && languages.length > 0 ? languages.join(', ') : 'unknown';
    const headline = headlineForCreatedState(state);
    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text>
          <Text color={theme.success}>{'✓'}</Text>
          {' '}
          {headline} for <Text bold>{langDisplay}</Text> in <Text dimColor>{cwd}</Text>
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
        {preExistingFiles && preExistingFiles.length > 0 && (
          <Box flexDirection="column" paddingTop={1}>
            <Text dimColor>{'  '}Pre-existing files:</Text>
            {preExistingFiles.map((f) => (
              <Text key={f.path}>
                {'    '}
                <Text dimColor>{relativize(f.path, cwd)}</Text>
                {'  '}
                <Text color={classificationColor(f.classification, theme)}>({f.classification})</Text>
              </Text>
            ))}
          </Box>
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

function headlineForPartialState(
  state: 'partial-config-only' | 'partial-dir-only' | 'fully-initialized',
  configFilename: string,
): string {
  switch (state) {
    case 'fully-initialized': {
      return 'Already initialized';
    }
    case 'partial-config-only': {
      return `${configFilename} present but opensip-tools/ missing`;
    }
    case 'partial-dir-only': {
      return `opensip-tools/ present but ${configFilename} missing`;
    }
  }
}

function headlineForCreatedState(state: InitFeedbackProps['state']): string {
  switch (state) {
    case 'fully-initialized': {
      return 'Re-scaffolded';
    }
    case 'partial-config-only':
    case 'partial-dir-only': {
      return 'Recovered partial state';
    }
    case 'pristine':
    case undefined: {
      return 'Scaffolded';
    }
  }
}

function classificationColor(
  cls: PreExistingFile['classification'],
  theme: ReturnType<typeof useTheme>,
): string {
  switch (cls) {
    case 'custom': {
      return theme.success;
    }
    case 'stale-scaffolded': {
      return theme.warning;
    }
    case 'scaffolded': {
      return theme.brand;
    }
  }
}

/** Display a path relative to cwd when it's underneath, otherwise absolute. */
function relativize(p: string, cwd: string): string {
  if (p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1);
  return p;
}
