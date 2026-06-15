import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { DEFAULT_THEME, ThemeProvider, detectTerminalCapabilities, useTheme } from '../theme.js';

describe('DEFAULT_THEME', () => {
  it('exposes the canonical brand and status colors', () => {
    expect(DEFAULT_THEME.brand).toBe('#C8956C');
    expect(DEFAULT_THEME.success).toBe('green');
    expect(DEFAULT_THEME.error).toBe('red');
    expect(DEFAULT_THEME.warning).toBe('yellow');
    expect(DEFAULT_THEME.info).toBe('cyan');
    expect(DEFAULT_THEME.muted).toBe('gray');
    expect(DEFAULT_THEME.colorsEnabled).toBe(true);
  });
});

describe('detectTerminalCapabilities', () => {
  const originalEnv = { ...process.env };
  const originalIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    delete process.env.NO_COLOR;
    delete process.env.COLORTERM;
    delete process.env.TERM_PROGRAM;
    delete process.env.TERM;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  it('returns all-false capabilities when NO_COLOR is set', () => {
    process.env.NO_COLOR = '1';
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const caps = detectTerminalCapabilities();
    expect(caps.supportsColor).toBe(false);
    expect(caps.supports256Color).toBe(false);
    expect(caps.supportsTrueColor).toBe(false);
  });

  it('reports truecolor when COLORTERM=truecolor and stdout is a TTY', () => {
    process.env.COLORTERM = 'truecolor';
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const caps = detectTerminalCapabilities();
    expect(caps.isTTY).toBe(true);
    expect(caps.supportsTrueColor).toBe(true);
    expect(caps.supports256Color).toBe(true);
    expect(caps.supportsColor).toBe(true);
  });

  it('reports truecolor for COLORTERM=24bit', () => {
    process.env.COLORTERM = '24bit';
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    expect(detectTerminalCapabilities().supportsTrueColor).toBe(true);
  });

  it('reports truecolor for known TERM_PROGRAM values', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    for (const tp of ['iTerm.app', 'WezTerm', 'Hyper']) {
      process.env.TERM_PROGRAM = tp;
      expect(detectTerminalCapabilities().supportsTrueColor).toBe(true);
    }
  });

  it('reports 256color when TERM contains "256color"', () => {
    process.env.TERM = 'xterm-256color';
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const caps = detectTerminalCapabilities();
    expect(caps.supports256Color).toBe(true);
    expect(caps.supportsTrueColor).toBe(false);
    expect(caps.supportsColor).toBe(true);
  });

  it('reports 256color for Apple_Terminal', () => {
    process.env.TERM_PROGRAM = 'Apple_Terminal';
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    expect(detectTerminalCapabilities().supports256Color).toBe(true);
  });

  it('gates every capability flag on isTTY', () => {
    process.env.COLORTERM = 'truecolor';
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    const caps = detectTerminalCapabilities();
    expect(caps.isTTY).toBe(false);
    expect(caps.supportsColor).toBe(false);
    expect(caps.supports256Color).toBe(false);
    expect(caps.supportsTrueColor).toBe(false);
  });

  it('returns supportsColor=false for a dumb TTY', () => {
    process.env.TERM = 'dumb';
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    expect(detectTerminalCapabilities().supportsColor).toBe(false);
  });
});

function ProbeTheme({
  onTheme,
}: Readonly<{ onTheme: (t: ReturnType<typeof useTheme>) => void }>): React.ReactElement {
  const t = useTheme();
  onTheme(t);
  return <Text>x</Text>;
}

describe('ThemeProvider / useTheme', () => {
  it('supplies the explicit theme prop verbatim', () => {
    let captured: ReturnType<typeof useTheme> | undefined;
    const custom = { ...DEFAULT_THEME, brand: '#000000' };
    render(
      <ThemeProvider theme={custom}>
        <ProbeTheme
          onTheme={(t) => {
            captured = t;
          }}
        />
      </ThemeProvider>,
    );
    expect(captured?.brand).toBe('#000000');
  });

  it('falls back to DEFAULT_THEME or NO_COLOR_THEME when no theme prop is given', () => {
    let captured: ReturnType<typeof useTheme> | undefined;
    render(
      <ThemeProvider>
        <ProbeTheme
          onTheme={(t) => {
            captured = t;
          }}
        />
      </ThemeProvider>,
    );
    // The resolved theme depends on the test runner's terminal — we just
    // assert one of the two well-known shapes was picked.
    expect(captured).toBeDefined();
    expect(typeof captured?.brand).toBe('string');
    expect(typeof captured?.colorsEnabled).toBe('boolean');
  });

  it('returns DEFAULT_THEME outside any ThemeProvider', () => {
    let captured: ReturnType<typeof useTheme> | undefined;
    render(
      <ProbeTheme
        onTheme={(t) => {
          captured = t;
        }}
      />,
    );
    expect(captured).toEqual(DEFAULT_THEME);
  });

  describe('with no theme prop, driven by detected capabilities', () => {
    const originalEnv = { ...process.env };
    const originalIsTTY = process.stdout.isTTY;

    afterEach(() => {
      process.env = { ...originalEnv };
      Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
    });

    it('resolves a no-color theme when color is unsupported (NO_COLOR set)', () => {
      process.env.NO_COLOR = '1';
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      let captured: ReturnType<typeof useTheme> | undefined;
      render(
        <ThemeProvider>
          <ProbeTheme
            onTheme={(t) => {
              captured = t;
            }}
          />
        </ThemeProvider>,
      );
      expect(captured?.colorsEnabled).toBe(false);
      expect(captured?.brand).toBe('');
    });

    it('resolves DEFAULT_THEME when color is supported', () => {
      delete process.env.NO_COLOR;
      process.env.COLORTERM = 'truecolor';
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      let captured: ReturnType<typeof useTheme> | undefined;
      render(
        <ThemeProvider>
          <ProbeTheme
            onTheme={(t) => {
              captured = t;
            }}
          />
        </ThemeProvider>,
      );
      expect(captured).toEqual(DEFAULT_THEME);
    });
  });
});
