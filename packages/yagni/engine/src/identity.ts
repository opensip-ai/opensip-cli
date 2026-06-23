import type { ToolIdentity } from '@opensip-cli/core';

export const YAGNI_IDENTITY = {
  name: 'yagni',
  aliases: ['yag'],
} as const satisfies ToolIdentity;

export const YAGNI_LIVE_VIEW_KEY = YAGNI_IDENTITY.name;
export const YAGNI_LAYOUT_KEY = YAGNI_IDENTITY.name;
