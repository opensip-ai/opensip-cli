import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadGraphReadConfig } from '../read/config.js';

const loadGraphConfigMock = vi.hoisted(() => vi.fn());

vi.mock('../cli/graph-config.js', () => ({
  loadGraphConfig: loadGraphConfigMock,
}));

afterEach(() => {
  loadGraphConfigMock.mockReset();
});

describe('loadGraphReadConfig', () => {
  it('forwards project root and optional config path to the producer loader', () => {
    const config = { resolutionMode: 'exact' } as const;
    loadGraphConfigMock.mockReturnValue(config);
    expect(loadGraphReadConfig('/proj')).toBe(config);
    expect(loadGraphConfigMock).toHaveBeenCalledWith('/proj', undefined);
    expect(loadGraphReadConfig('/proj', 'opensip-cli.config.yml')).toBe(config);
    expect(loadGraphConfigMock).toHaveBeenCalledWith('/proj', 'opensip-cli.config.yml');
  });
});
