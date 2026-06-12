// Fixture fit-pack check (packed-smoke Phase 1). A third-party
// `kind: "fit-pack"` package: installed via `opensip plugin add
// --domain fit`, discovered by marker, and registered as a single check
// with a known unique slug so the smoke test can narrow `fit --check` to it.
//
// Authored against the installed `@opensip-cli/fitness` so it goes through
// the real `defineCheck` API (and therefore resolves the same
// `@opensip-cli/core` the engine uses — exercising the single-core path).
// The check flags any file containing the marker string `FIT_PACK_FIXTURE`.
import { defineCheck } from '@opensip-cli/fitness';

export const fitPackFixtureCheck = defineCheck({
  id: 'ffb43cff-f9e0-4ba1-b968-269e82e60774',
  slug: 'fit-pack-fixture-marker',
  description: 'Fixture fit-pack check: flags the FIT_PACK_FIXTURE marker',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  tags: ['quality'],
  fileTypes: ['ts'],
  analyze: (content, filePath) => {
    const violations = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('FIT_PACK_FIXTURE')) {
        violations.push({
          message: 'FIT_PACK_FIXTURE marker detected',
          severity: 'error',
          filePath,
          line: i + 1,
          column: 0,
          suggestion: 'Remove the fixture marker',
        });
      }
    }
    return violations;
  },
});
