import { defineCheck } from '@opensip-cli/fitness';

// This file imports a hot engine path (fitness, graph, simulation, or lang-*)
// but does *not* wrap the call in an observability span, and carries no
// fitness-ignore directive. The check must report a violation.
// (NOTE: this comment must not spell out the ignore marker verbatim — the
// check's suppression regex scans raw content, so writing it here would
// suppress the very violation this fixture exists to produce.)
import { someExpensiveEngineWork } from '@opensip-cli/fitness/engine';

export const badCheck = defineCheck({
  id: '11111111-1111-1111-1111-111111111111',
  slug: 'bad-check',
  description: 'example',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  analyze() {
    // direct call, no observability wrapper
    return someExpensiveEngineWork();
  },
});
