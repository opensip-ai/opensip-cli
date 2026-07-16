import { defineCommand, definePrimaryCommand, defineNestedCommand } from '@opensip-cli/core';
import { definePrimaryRunCommand } from '@opensip-cli/contracts';

function handleSample(): undefined {
  return undefined;
}

export const sample = defineCommand({
  name: 'sample',
  description: 'violation',
  commonFlags: [],
  scope: 'none',
  output: 'command-result',
  handler: handleSample,
});

export const primary = definePrimaryCommand({
  description: 'primary',
  commonFlags: [],
  scope: 'none',
  output: 'command-result',
  handler: handleSample,
});

export const nested = defineNestedCommand({
  name: 'nested',
  description: 'nested',
  commonFlags: [],
  scope: 'none',
  output: 'command-result',
  handler: handleSample,
});

export const run = definePrimaryRunCommand({
  description: 'run',
  handler: handleSample,
});

// Present but incomplete staticHandler (missing declaration) is a violation.
export const incomplete = defineCommand({
  name: 'incomplete',
  description: 'incomplete staticHandler',
  commonFlags: [],
  scope: 'none',
  output: 'command-result',
  staticHandler: {
    package: 'opensip-cli',
    path: 'packages/cli/src/commands/sample.ts',
  } as { package: string; path: string; declaration: string },
  handler: handleSample,
});

// Method form without staticHandler is still a violation.
export const methodMissing = defineCommand({
  name: 'method-missing',
  description: 'method without staticHandler',
  commonFlags: [],
  scope: 'none',
  output: 'command-result',
  handler() {
    return undefined;
  },
});
