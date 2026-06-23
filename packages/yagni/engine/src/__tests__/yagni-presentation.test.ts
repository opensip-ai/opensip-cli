import { describe, expect, it, vi } from 'vitest';

import { executeYagni } from '../cli/execute-yagni.js';
import { buildYagniPresentationLines } from '../cli/yagni-presentation.js';
import { duplicateBodyCandidateDetector } from '../detectors/duplicate-body-candidate.js';
import { unusedConfigSurfaceDetector } from '../detectors/unused-config-surface.js';

import type { ToolCliContext } from '@opensip-cli/core';

const FIXTURE_ROOT = new URL('fixtures/unused-config-surface/pkg', import.meta.url).pathname;

function stubCli(): ToolCliContext {
  return {
    scope: { datastore: () => undefined },
    deliverSignals: vi.fn(() => Promise.resolve({ delivered: false })),
  } as unknown as ToolCliContext;
}

describe('yagni presentation', () => {
  it('renders compact summary with net footer for default output', async () => {
    const outcome = await executeYagni(
      {
        cwd: FIXTURE_ROOT,
        config: { graphMode: 'off', defaultMinConfidence: 'low' },
        graphMode: 'off',
        includeTests: true,
      },
      stubCli(),
      [unusedConfigSurfaceDetector, duplicateBodyCandidateDetector],
    );
    const lines = buildYagniPresentationLines(
      outcome.envelope,
      FIXTURE_ROOT,
      'off',
      outcome.session.payload.summary.skippedDetectors,
      false,
    );
    const text = lines.join('\n');
    expect(text).toContain('YAGNI audit: 1 reduction candidates');
    expect(text).toContain('High confidence');
    expect(text).toContain('unused-config-surface');
    expect(text).toContain('net: ~1 LOC possible');
    expect(text).toContain('Run with --verbose for evidence');
  });
});
