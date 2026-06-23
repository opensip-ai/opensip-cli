import type { ToolIdentity } from '@opensip-cli/core';

export const GRAPH_IDENTITY: ToolIdentity = {
  name: 'graph',
};

export const GRAPH_LIVE_VIEW_KEY = GRAPH_IDENTITY.name;
export const GRAPH_LAYOUT_KEY = GRAPH_IDENTITY.layoutKey ?? 'graph';