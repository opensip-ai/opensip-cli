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

// In a no-color theme, all color tokens are zeroed out: Ink does not read
// `colorsEnabled` itself, so handing it any non-empty color string (`'red'`,
// `'#C8956C'`) would still emit ANSI escapes even with `NO_COLOR=1`. Empty
// strings cause Ink's `<Text color={...}>` to no-op, honoring the NO_COLOR
// convention without forcing every component to guard `theme.colorsEnabled`
// at every call site.
const NO_COLOR_THEME: Theme = {
  brand: '',
  success: '',
  error: '',
  warning: '',
  info: '',
  muted: '',
  scoreHigh: '',
  scoreMid: '',
  scoreLow: '',
  statusPass: '',
  statusFail: '',
  statusTimeout: '',
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

  const envSuggestsTrueColor =
    colorTerm === 'truecolor' ||
    colorTerm === '24bit' ||
    termProgram === 'iTerm.app' ||
    termProgram === 'WezTerm' ||
    termProgram === 'Hyper';

  const envSuggests256Color =
    envSuggestsTrueColor ||
    term.includes('256color') ||
    termProgram === 'Apple_Terminal';

  // All capability flags MUST be gated on `isTTY`. When stdout is piped to a
  // file or CI log, ANSI truecolor escapes still leak in if callers inspect
  // `supports256Color` / `supportsTrueColor` to decide whether to emit hex
  // color values — even though `supportsColor` itself is correctly false.
  // Treating capability as a single coherent gate (`isTTY && env signal`)
  // prevents the exported surface from contradicting itself.
  const supportsTrueColor = isTTY && envSuggestsTrueColor;
  const supports256Color = isTTY && envSuggests256Color;
  const supportsColor = isTTY && (envSuggests256Color || term !== 'dumb');

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
  // Memoize the resolved theme so the context value reference is stable
  // across re-renders. Ink's ClockProvider tick re-renders ThemeProvider
  // on every frame; without useMemo, every render would re-read
  // process.env, allocate a new `resolved` object, and force every
  // `useTheme()` subscriber (Banner, Spinner, RunHeader, …) to re-render
  // unnecessarily. Capability detection reads stable process state, so
  // recomputing only when `theme` changes is correct.
  const resolved = React.useMemo(() => {
    if (theme) return theme;
    const caps = detectTerminalCapabilities();
    return caps.supportsColor ? DEFAULT_THEME : NO_COLOR_THEME;
  }, [theme]);

  return React.createElement(ThemeContext.Provider, { value: resolved }, children);
}

export function useTheme(): Theme {
  return React.useContext(ThemeContext);
}
