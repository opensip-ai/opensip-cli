import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { detectTerminalCapabilities, ThemeContext } from '../../ui/theme.js';

describe('theme', () => {
  describe('detectTerminalCapabilities', () => {
    let origIsTTY: boolean | undefined;
    let origNoColor: string | undefined;

    beforeEach(() => {
      origIsTTY = process.stdout.isTTY;
      origNoColor = process.env.NO_COLOR;
    });

    afterEach(() => {
      process.stdout.isTTY = origIsTTY!;
      if (origNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = origNoColor;
      }
    });

    it('returns colorsEnabled=false when NO_COLOR=1', () => {
      process.env.NO_COLOR = '1';
      const caps = detectTerminalCapabilities();
      expect(caps.supportsColor).toBe(false);
      expect(caps.supports256Color).toBe(false);
      expect(caps.supportsTrueColor).toBe(false);
    });

    it('returns isTTY=false when stdout is not a TTY', () => {
      process.stdout.isTTY = false;
      delete process.env.NO_COLOR;
      const caps = detectTerminalCapabilities();
      expect(caps.isTTY).toBe(false);
      // supportsColor requires isTTY
      expect(caps.supportsColor).toBe(false);
    });

    it('returns isTTY=true when stdout is a TTY', () => {
      process.stdout.isTTY = true;
      delete process.env.NO_COLOR;
      const caps = detectTerminalCapabilities();
      expect(caps.isTTY).toBe(true);
    });
  });

  describe('theme tokens', () => {
    it('default theme has all expected color tokens', () => {
      // Access the default value from the context — React.createContext stores it
      const defaultTheme = (ThemeContext as unknown as { _currentValue: Record<string, unknown> })._currentValue;
      const expectedKeys = [
        'brand', 'success', 'error', 'warning', 'info', 'muted',
        'scoreHigh', 'scoreMid', 'scoreLow',
        'statusPass', 'statusFail', 'statusTimeout',
        'colorsEnabled',
      ];
      for (const key of expectedKeys) {
        expect(defaultTheme).toHaveProperty(key);
      }
    });
  });
});
