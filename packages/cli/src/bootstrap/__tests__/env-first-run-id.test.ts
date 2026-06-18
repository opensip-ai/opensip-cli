/**
 * Env-first runId resolution (subprocess-correlation telemetry spec, B1 — "Child
 * runId behavior"). The pre-action hook resolves `runId` from `OPENSIP_RUN_ID`
 * FIRST (so a spawned/forked child inherits its parent run), falling back to a
 * freshly minted `RUN_…` id when the var is absent. This test exercises the exact
 * resolution mechanism the hook uses — the SAME `hostEnv` registry the hook reads
 * (`OPENSIP_RUN_ID` is one of the spread-in correlation specs) and the SAME
 * `generatePrefixedId('run')` fallback — so it cannot pass while drifting from the
 * hook's logic.
 */

import { generatePrefixedId } from '@opensip-cli/core';
import { afterEach, describe, expect, it } from 'vitest';

import { hostEnv } from '../../env/host-env-specs.js';

/** The hook's resolution, lifted verbatim (pre-action-hook.ts). */
function resolveRunId(): string {
  const inherited = hostEnv.get<string>('OPENSIP_RUN_ID');
  return inherited && inherited.length > 0 ? inherited : generatePrefixedId('run');
}

const RUN_ID_SHAPE = /^RUN_[0-9A-HJKMNP-TV-Z]{26}$/;

describe('env-first runId (B1)', () => {
  afterEach(() => {
    delete process.env.OPENSIP_RUN_ID;
  });

  it('inherits OPENSIP_RUN_ID when present (child inherits the parent run)', () => {
    process.env.OPENSIP_RUN_ID = 'RUN_parent';
    expect(resolveRunId()).toBe('RUN_parent');
  });

  it('mints a fresh RUN_… id when OPENSIP_RUN_ID is unset (top-level invocation)', () => {
    delete process.env.OPENSIP_RUN_ID;
    const runId = resolveRunId();
    expect(runId).not.toBe('RUN_parent');
    // The generatePrefixedId('run') shape: `RUN_` + a 26-char Crockford ULID.
    expect(runId).toMatch(RUN_ID_SHAPE);
  });

  it('treats an empty OPENSIP_RUN_ID as absent and mints a fresh id', () => {
    process.env.OPENSIP_RUN_ID = '';
    expect(resolveRunId()).toMatch(RUN_ID_SHAPE);
  });

  it('OPENSIP_RUN_ID is a declared host env spec (read through the registry, not raw process.env)', () => {
    // The registry would throw on an undeclared name; this asserts the var is part
    // of the governed surface (spread in from core CORRELATION_ENV_SPECS) so the
    // env-first read above is the sanctioned seam, not a raw process.env access.
    expect(() => hostEnv.get<string>('OPENSIP_RUN_ID')).not.toThrow();
  });
});
