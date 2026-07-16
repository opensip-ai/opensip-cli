import { ConfigurationError, type ToolCliContext } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { readOptionalToolConfig, readToolConfig } from './tool-config-read.js';

function cliWithToolConfig(toolConfig: ToolCliContext['scope']['toolConfig']): ToolCliContext {
  return {
    scope: { toolConfig, datastore: () => undefined },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as ToolCliContext;
}

describe('tool config read helpers', () => {
  it('returns defaults when the namespace is absent', () => {
    const config = readToolConfig(
      cliWithToolConfig({}),
      'yagni',
      (raw) => raw as { enabled: boolean },
      { enabled: false },
    );

    expect(config).toEqual({ enabled: false });
  });

  it('parses present namespace config with safeParse parsers', () => {
    const parser = {
      safeParse: (raw: unknown) => ({
        success: true as const,
        data: raw as { threshold: number },
      }),
    };

    expect(
      readOptionalToolConfig(cliWithToolConfig({ graph: { threshold: 3 } }), 'graph', parser),
    ).toEqual({ threshold: 3 });
  });

  it('throws configuration errors for malformed shapes', () => {
    expect(() =>
      readOptionalToolConfig(cliWithToolConfig({ yagni: 'bad' as never }), 'yagni', (raw) => raw),
    ).toThrow(ConfigurationError);

    expect(() =>
      readOptionalToolConfig(cliWithToolConfig({ yagni: { bad: true } }), 'yagni', {
        safeParse: () => ({ success: false as const, error: new Error('bad') }),
      }),
    ).toThrow(ConfigurationError);
  });

  it('parses with a function parser and rethrows ConfigurationError without wrapping', () => {
    expect(
      readOptionalToolConfig(
        cliWithToolConfig({ graph: { threshold: 9 } }),
        'graph',
        (raw) => raw as { threshold: number },
      ),
    ).toEqual({ threshold: 9 });

    expect(() =>
      readOptionalToolConfig(cliWithToolConfig({ graph: { threshold: 1 } }), 'graph', () => {
        throw new ConfigurationError('already shaped');
      }),
    ).toThrow('already shaped');
  });

  it('wraps unexpected parser throws as ConfigurationError', () => {
    expect(() =>
      readOptionalToolConfig(cliWithToolConfig({ graph: { threshold: 1 } }), 'graph', () => {
        throw new TypeError('boom');
      }),
    ).toThrow(ConfigurationError);
  });
});
