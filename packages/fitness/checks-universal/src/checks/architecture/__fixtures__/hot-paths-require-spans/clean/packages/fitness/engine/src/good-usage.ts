import { withSpanAsync } from '@opensip-cli/core';

// This file imports a hot engine path but properly wraps the call site
// with withSpanAsync (or withSpan). The check must not flag it.
import { someExpensiveEngineWork } from '@opensip-cli/fitness/engine';

export async function doGoodThing() {
  return withSpanAsync('my-tracer', 'engine-work', async (span) => {
    span.setAttributes({ foo: 'bar' });
    return someExpensiveEngineWork();
  });
}
