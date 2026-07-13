import type { ToolIdentity } from '@opensip-cli/core';

export const GRAPH_IDENTITY: ToolIdentity = {
  name: 'graph',
};

/** Stable plugin identity shared by descriptors, context evidence, and presets. */
export const GRAPH_STABLE_ID = '3873f1c2-02a9-4719-930a-bca74b62b706';

export const GRAPH_LIVE_VIEW_KEY = GRAPH_IDENTITY.name;
export const GRAPH_LAYOUT_KEY = GRAPH_IDENTITY.layoutKey ?? 'graph';
