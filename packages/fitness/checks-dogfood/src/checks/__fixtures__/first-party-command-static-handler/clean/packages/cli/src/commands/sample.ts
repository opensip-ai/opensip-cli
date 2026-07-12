import { defineCommand, definePrimaryCommand, defineNestedCommand } from '@opensip-cli/core';
import { definePrimaryRunCommand } from '@opensip-cli/contracts';

function handleSample(): undefined {
  return undefined;
}

export const sample = defineCommand({
  name: 'sample',
  description: 'clean',
  commonFlags: [],
  scope: 'none',
  output: 'command-result',
  staticHandler: {
    package: 'opensip-cli',
    path: 'packages/cli/src/commands/sample.ts',
    declaration: 'handleSample',
  },
  handler: handleSample,
});

export const primary = definePrimaryCommand({
  description: 'primary',
  commonFlags: [],
  scope: 'none',
  output: 'command-result',
  staticHandler: {
    package: 'opensip-cli',
    path: 'packages/cli/src/commands/sample.ts',
    declaration: 'handleSample',
  },
  handler: handleSample,
});

export const nested = defineNestedCommand({
  name: 'nested',
  description: 'nested',
  commonFlags: [],
  scope: 'none',
  output: 'command-result',
  staticHandler: {
    package: 'opensip-cli',
    path: 'packages/cli/src/commands/sample.ts',
    declaration: 'handleSample',
  },
  handler: handleSample,
});

export const run = definePrimaryRunCommand({
  description: 'run',
  staticHandler: {
    package: 'opensip-cli',
    path: 'packages/cli/src/commands/sample.ts',
    declaration: 'handleSample',
  },
  handler: handleSample,
});

// Local same-named function must not trigger the check.
function defineCommand(): void {
  return;
}
defineCommand();
