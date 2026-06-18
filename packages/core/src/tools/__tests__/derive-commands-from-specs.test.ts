import { describe, expect, it } from 'vitest';

import { defineCommand } from '../command-spec-validate.js';
import { resolveToolCommandNames, resolveToolCommands } from '../derive-commands-from-specs.js';

import type { Tool } from '../types.js';

describe('resolveToolCommands', () => {
  it('prefers commandSpecs over a stale commands[] (mount surface wins)', () => {
    const tool = {
      metadata: { id: 'demo', name: 'demo', version: '0.0.0', description: 'demo' },
      commands: [{ name: 'legacy-cmd', description: 'stale' }],
      commandSpecs: [
        defineCommand({
          name: 'new-cmd',
          description: 'authoritative',
          commonFlags: ['json'],
          scope: 'none',
          output: 'command-result',
          handler: () => Promise.resolve({ type: 'text-lines', title: 't', lines: [] }),
        }),
      ],
    } satisfies Tool;

    expect(resolveToolCommandNames(tool)).toEqual(['new-cmd']);
    expect(resolveToolCommands(tool)[0]?.name).toBe('new-cmd');
  });

  it('falls back to commands[] when commandSpecs is absent', () => {
    const tool = {
      metadata: { id: 'demo', name: 'demo', version: '0.0.0', description: 'demo' },
      commands: [{ name: 'legacy-only', description: 'legacy' }],
    } satisfies Tool;

    expect(resolveToolCommandNames(tool)).toEqual(['legacy-only']);
  });
});
