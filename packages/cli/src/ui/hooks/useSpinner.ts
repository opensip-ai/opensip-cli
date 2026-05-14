/* eslint-disable unicorn/filename-case -- React `useXxx` hook convention; renaming to kebab-case obscures the hook role */
/**
 * useSpinner hook — returns the current spinner frame character.
 * Consumes the ClockContext to cycle through braille animation frames.
 */

import { useClock } from './useClock.js';

const SPINNER_FRAMES = [
  '\u280B', '\u2819', '\u2839', '\u2838',
  '\u283C', '\u2834', '\u2826', '\u2827',
  '\u2807', '\u280F',
];

export function useSpinner(): string {
  const tick = useClock();
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
}
