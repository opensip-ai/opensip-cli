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

// Method-form and shorthand handlers are still leaves that need staticHandler.
export const methodForm = defineCommand({
  name: 'method-form',
  description: 'method handler form',
  commonFlags: [],
  scope: 'none',
  output: 'command-result',
  staticHandler: {
    package: 'opensip-cli',
    path: 'packages/cli/src/commands/sample.ts',
    declaration: 'handleSample',
  },
  handler() {
    return undefined;
  },
});

const handler = handleSample;
export const shorthand = defineCommand({
  name: 'shorthand',
  description: 'shorthand handler',
  commonFlags: [],
  scope: 'none',
  output: 'command-result',
  staticHandler: {
    package: 'opensip-cli',
    path: 'packages/cli/src/commands/sample.ts',
    declaration: 'handleSample',
  },
  handler,
});

// Local same-named function must not trigger the check.
function defineCommand(): void {
  return;
}
defineCommand();
