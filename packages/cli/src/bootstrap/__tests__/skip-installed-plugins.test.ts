import { describe, expect, it } from 'vitest';

import {
  isNoPluginsArgvFlag,
  shouldSkipInstalledToolDiscovery,
  SKIP_INSTALLED_PLUGINS_ENV,
} from '../skip-installed-plugins.js';

describe('skip-installed-plugins', () => {
  it('isNoPluginsArgvFlag is true when --no-plugins appears anywhere in argv', () => {
    expect(isNoPluginsArgvFlag(['--no-plugins', 'fit'])).toBe(true);
    expect(isNoPluginsArgvFlag(['fit', '--no-plugins'])).toBe(true);
    expect(isNoPluginsArgvFlag(['fit', '--json'])).toBe(false);
  });

  it('shouldSkipInstalledToolDiscovery honors --no-plugins', () => {
    expect(shouldSkipInstalledToolDiscovery(['fit', '--no-plugins'], {})).toBe(true);
  });

  it('shouldSkipInstalledToolDiscovery honors OPENSIP_CLI_SKIP_INSTALLED', () => {
    expect(
      shouldSkipInstalledToolDiscovery(['fit'], { [SKIP_INSTALLED_PLUGINS_ENV]: '1' }),
    ).toBe(true);
    expect(shouldSkipInstalledToolDiscovery(['fit'], {})).toBe(false);
    expect(shouldSkipInstalledToolDiscovery(['fit'], { [SKIP_INSTALLED_PLUGINS_ENV]: '' })).toBe(
      false,
    );
  });
});