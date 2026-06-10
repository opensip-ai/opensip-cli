/**
 * @fileoverview Regression test for the `context-leakage` FP fix.
 *
 * A module-level `let parentContext: Context` holding OpenTelemetry's W3C
 * trace-propagation context was flagged as request-context leakage because
 * the type name ends in "Context". OTel's `Context` is process/propagation
 * scoped, not the per-request tenant context this check targets. The fix
 * inspects the import source: only types imported from `@opentelemetry/*`
 * are spared, so a genuine `let activeContext: RequestContext` still fires.
 */

import { describe, expect, it } from 'vitest';

import { analyzeContextLeakage } from '../context-leakage.js';

function analyze(src: string): readonly { line: number }[] {
  return analyzeContextLeakage(src, 'src/cli/telemetry/sdk-init.ts');
}

describe('context-leakage — OTel Context FP regression', () => {
  it('does NOT flag a module-level binding typed as OTel-imported Context', () => {
    const src = `
      import { context as otelContext, type Context } from '@opentelemetry/api';
      let parentContext: Context | undefined;
      export function setParent(c: Context): void { parentContext = c; }
    `;
    expect(analyze(src)).toHaveLength(0);
  });

  it('STILL flags a module-level binding typed as a non-OTel request context', () => {
    const src = `
      import type { RequestContext } from './http.js';
      let activeContext: RequestContext | null = null;
      export function setCtx(c: RequestContext): void { activeContext = c; }
    `;
    expect(analyze(src).length).toBeGreaterThan(0);
  });
});
