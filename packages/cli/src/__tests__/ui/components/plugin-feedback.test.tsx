import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect } from 'vitest';

import { PluginFeedback } from '../../../ui/components/PluginFeedback.js';

import type { PluginResult } from '@opensip-tools/contracts';

describe('PluginFeedback', () => {
  describe('plugin-list', () => {
    it('shows "no plugins installed" hint when list is empty', () => {
      const result: PluginResult = {
        type: 'plugin-list',
        plugins: [],
        totalCount: 0,
      };
      const { lastFrame } = render(<PluginFeedback result={result} />);
      const out = lastFrame() ?? '';
      expect(out).toContain('Installed Plugins');
      expect(out).toContain('no plugins installed');
    });

    it('groups plugins by domain and renders package vs file icons', () => {
      const result: PluginResult = {
        type: 'plugin-list',
        plugins: [
          { domain: 'fit', namespace: '@scope/p-a', source: 'p-a', pluginType: 'package' },
          { domain: 'fit', namespace: 'file-b', source: 'file-b.mjs', pluginType: 'file' },
          { domain: 'sim', namespace: '@scope/sim-a', source: 'sim-a', pluginType: 'package' },
        ],
        totalCount: 3,
      };
      const { lastFrame } = render(<PluginFeedback result={result} />);
      const out = lastFrame() ?? '';
      expect(out).toContain('fit/');
      expect(out).toContain('sim/');
      expect(out).toContain('@scope/p-a');
      expect(out).toContain('file-b');
      expect(out).toContain('📦');
      expect(out).toContain('📄');
    });
  });

  describe('plugin-add', () => {
    it('renders success line', () => {
      const result: PluginResult = {
        type: 'plugin-add',
        packageName: '@x/y',
        success: true,
      };
      const { lastFrame } = render(<PluginFeedback result={result} />);
      const out = lastFrame() ?? '';
      expect(out).toContain('Installed @x/y');
      expect(out).toContain('✔');
    });

    it('renders failure line with optional error', () => {
      const result: PluginResult = {
        type: 'plugin-add',
        packageName: '@x/y',
        success: false,
        error: 'permissions',
      };
      const { lastFrame } = render(<PluginFeedback result={result} />);
      const out = lastFrame() ?? '';
      expect(out).toContain('Failed to install @x/y');
      expect(out).toContain('permissions');
      expect(out).toContain('✗');
    });
  });

  describe('plugin-remove', () => {
    it('renders success line', () => {
      const result: PluginResult = {
        type: 'plugin-remove',
        packageName: '@x/y',
        success: true,
      };
      const { lastFrame } = render(<PluginFeedback result={result} />);
      expect(lastFrame()).toContain('Removed @x/y');
    });

    it('renders failure line', () => {
      const result: PluginResult = {
        type: 'plugin-remove',
        packageName: '@x/y',
        success: false,
      };
      expect(render(<PluginFeedback result={result} />).lastFrame()).toContain('Failed to remove');
    });
  });

  describe('plugin-sync', () => {
    it('renders the "no plugins declared" hint when synced is empty', () => {
      const result: PluginResult = {
        type: 'plugin-sync',
        synced: [],
        success: true,
      };
      const { lastFrame } = render(<PluginFeedback result={result} />);
      expect(lastFrame()).toContain('No plugins declared');
    });

    it('renders one row per synced entry', () => {
      const result: PluginResult = {
        type: 'plugin-sync',
        synced: [
          { domain: 'fit', package: '@x/a', installed: true },
          { domain: 'sim', package: '@x/b', installed: false },
        ],
        success: false,
        errors: ['npm install failed for @x/b'],
      };
      const { lastFrame } = render(<PluginFeedback result={result} />);
      const out = lastFrame() ?? '';
      expect(out).toContain('@x/a');
      expect(out).toContain('@x/b');
      expect(out).toContain('npm install failed');
      expect(out).toContain('One or more plugins failed');
    });

    it('shows success message when all installed', () => {
      const result: PluginResult = {
        type: 'plugin-sync',
        synced: [{ domain: 'fit', package: '@x/a', installed: true }],
        success: true,
      };
      const { lastFrame } = render(<PluginFeedback result={result} />);
      expect(lastFrame()).toContain('All plugins synced successfully');
    });
  });
});
