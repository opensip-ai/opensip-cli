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
