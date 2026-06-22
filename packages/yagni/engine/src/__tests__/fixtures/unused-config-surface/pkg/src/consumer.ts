import type { AppConfig } from './app-config.js';

export function readUsed(config: AppConfig): string {
  return config.usedKnob;
}