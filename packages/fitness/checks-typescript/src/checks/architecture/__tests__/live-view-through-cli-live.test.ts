import { describe, expect, it } from 'vitest';

import { analyzeLiveViewThroughCliLive } from '../live-view-through-cli-live.js';

describe('live-view-through-cli-live', () => {
  it('flags direct ink render imports in tool engines', () => {
    const violations = analyzeLiveViewThroughCliLive(
      `import { render } from 'ink';\n`,
      'packages/fitness/engine/src/cli/fit-runner.tsx',
    );
    expect(violations).toHaveLength(1);
  });

  it('passes when the engine uses cli-live', () => {
    const violations = analyzeLiveViewThroughCliLive(
      `import { runToolLiveView } from '@opensip-cli/cli-live';\n`,
      'packages/fitness/engine/src/cli/fit-runner.tsx',
    );
    expect(violations).toHaveLength(0);
  });
});
