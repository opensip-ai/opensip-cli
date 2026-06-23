import type { ToolIdentity } from '@opensip-cli/core';

/** Single source of truth for fitness tool naming. */
export const FITNESS_IDENTITY = {
  name: 'fitness',
  aliases: ['fit'],
  layoutKey: 'fit',
} as const satisfies ToolIdentity;

/** Host-dispatched live-view key — canonical identity name. */
export const FITNESS_LIVE_VIEW_KEY = FITNESS_IDENTITY.name;

/** Persisted session / envelope discriminant. */
export const FITNESS_LAYOUT_KEY = FITNESS_IDENTITY.layoutKey ?? 'fit';
