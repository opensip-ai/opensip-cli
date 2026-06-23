import type { ToolIdentity } from '@opensip-cli/core';

export const SIMULATION_IDENTITY = {
  name: 'simulation',
  aliases: ['sim'],
  layoutKey: 'sim',
} as const satisfies ToolIdentity;

export const SIMULATION_LIVE_VIEW_KEY = SIMULATION_IDENTITY.name;
export const SIMULATION_LAYOUT_KEY = SIMULATION_IDENTITY.layoutKey ?? 'sim';
