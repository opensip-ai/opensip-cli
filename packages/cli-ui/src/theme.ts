/**
 * Theme system for Ink UI components.
 *
 * Provides color tokens, terminal capability detection, and a React context
 * so every component can access the theme via useTheme().
 */

import React from 'react';

// ---------------------------------------------------------------------------
// Theme interface
// ---------------------------------------------------------------------------

export interface Theme {
  /** OpenSIP brand color — warm amber */
  readonly brand: string;
  readonly success: string;
  readonly error: string;
  readonly warning: string;
  readonly info: string;
  readonly muted: string;

  /** Score color thresholds */
  readonly scoreHigh: string;
  readonly scoreMid: string;
  readonly scoreLow: string;

  /** Check status colors */
  readonly statusPass: string;
  readonly statusFail: string;
  readonly statusTimeout: string;

  /** Whether color output is enabled */
  readonly colorsEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Default theme
// ---------------------------------------------------------------------------

export const DEFAULT_THEME: Theme = {
  brand: '#C8956C',
  success: 'green',
  error: 'red',
  warning: 'yellow',
  info: 'cyan',
  muted: 'gray',

  scoreHigh: 'green',
  scoreMid: 'yellow',
  scoreLow: 'red',

  statusPass: 'green',
  statusFail: 'red',
  statusTimeout: 'yellow',

  colorsEnabled: true,
};

const NO_COLOR_THEME: Theme = {
  ...DEFAULT_THEME,
  colorsEnabled: false,
};

// ---------------------------------------------------------------------------
// Terminal capability detection
// ---------------------------------------------------------------------------

export interface TerminalCapabilities {
  readonly isTTY: boolean;
  readonly supportsColor: boolean;
  readonly supports256Color: boolean;
  readonly supportsTrueColor: boolean;
}

export function detectTerminalCapabilities(): TerminalCapabilities {
  const isTTY = !!process.stdout.isTTY;
  const noColor = !!process.env.NO_COLOR;
  const colorTerm = process.env.COLORTERM ?? '';
  const termProgram = process.env.TERM_PROGRAM ?? '';
  const term = process.env.TERM ?? '';

  if (noColor) {
    return { isTTY, supportsColor: false, supports256Color: false, supportsTrueColor: false };
  }

  const supportsTrueColor =
    colorTerm === 'truecolor' ||
    colorTerm === '24bit' ||
    termProgram === 'iTerm.app' ||
    termProgram === 'WezTerm' ||
    termProgram === 'Hyper';

  const supports256Color =
    supportsTrueColor ||
    term.includes('256color') ||
    termProgram === 'Apple_Terminal';

  const supportsColor = isTTY && (supports256Color || term !== 'dumb');

  return { isTTY, supportsColor, supports256Color, supportsTrueColor };
}

// ---------------------------------------------------------------------------
// React context + provider + hook
// ---------------------------------------------------------------------------

export const ThemeContext = React.createContext<Theme>(DEFAULT_THEME);

export interface ThemeProviderProps {
  readonly theme?: Theme;
  readonly children: React.ReactNode;
}

export function ThemeProvider({ theme, children }: ThemeProviderProps): React.ReactElement {
  const caps = detectTerminalCapabilities();
  const resolved = theme ?? (caps.supportsColor ? DEFAULT_THEME : NO_COLOR_THEME);

  return React.createElement(ThemeContext.Provider, { value: resolved }, children);
}

export function useTheme(): Theme {
  return React.useContext(ThemeContext);
}
