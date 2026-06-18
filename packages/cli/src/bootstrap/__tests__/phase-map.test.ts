/**
 * BOOTSTRAP_PHASE_MAP completeness — every lifecycle step and pre-action phase
 * has a mapped implementing module (tool-author-simplify orchestration contract).
 */

import { describe, expect, it } from 'vitest';

import { BOOTSTRAP_PHASE_MAP } from '../phase-map.js';
import { PRE_ACTION_PHASES } from '../pre-action-bootstrap-phases.js';
import { TOOL_LIFECYCLE_STEPS } from '../tool-lifecycle.js';

describe('BOOTSTRAP_PHASE_MAP completeness', () => {
  it('maps every tool lifecycle step', () => {
    const mapped = new Set(
      BOOTSTRAP_PHASE_MAP.flatMap((entry) =>
        entry.lifecycleStep === undefined ? [] : [entry.lifecycleStep],
      ),
    );
    for (const step of Object.values(TOOL_LIFECYCLE_STEPS)) {
      expect(mapped.has(step), `missing lifecycle step ${step} in BOOTSTRAP_PHASE_MAP`).toBe(true);
    }
  });

  it('maps every pre-action phase', () => {
    const mapped = new Set(
      BOOTSTRAP_PHASE_MAP.flatMap((entry) =>
        entry.preActionPhase === undefined ? [] : [entry.preActionPhase],
      ),
    );
    for (const phase of Object.values(PRE_ACTION_PHASES)) {
      expect(mapped.has(phase), `missing pre-action phase ${phase} in BOOTSTRAP_PHASE_MAP`).toBe(
        true,
      );
    }
  });

  it('mount step references mountAllToolCommands directly (no pass-through driver)', () => {
    const mount = BOOTSTRAP_PHASE_MAP.find(
      (entry) => entry.lifecycleStep === TOOL_LIFECYCLE_STEPS.mount,
    );
    expect(mount?.symbol).toContain('mountAllToolCommands');
  });
});
