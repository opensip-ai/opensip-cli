import { describe, expect, it } from 'vitest';

import { analyzeTimerCallbacks } from '../timer-callback-async-needs-catch.js';

const PATH = 'src/example.ts';
const PRE = 'declare function p(): Promise<void>;\n';

function run(body: string): ReturnType<typeof analyzeTimerCallbacks> {
  return analyzeTimerCallbacks(PRE + body, PATH);
}

describe('timer-callback-async-needs-catch', () => {
  it('flags `void p().finally()` (no catch) inside setInterval — the heartbeat pattern', () => {
    const v = run('setInterval(() => { void p().finally(() => undefined); }, 100);');
    expect(v).toHaveLength(1);
    expect(v[0].type).toBe('timer-async-uncaught');
    expect(v[0].severity).toBe('warning');
  });

  it('passes when the chain has a `.catch`', () => {
    const v = run(
      'setInterval(() => { void p().catch(() => undefined).finally(() => undefined); }, 100);',
    );
    expect(v).toHaveLength(0);
  });

  it('passes a two-argument `.then(onFulfilled, onRejected)`', () => {
    const v = run('setTimeout(() => { void p().then(() => undefined, () => undefined); }, 100);');
    expect(v).toHaveLength(0);
  });

  it('flags a single-argument `.then` (no rejection handler)', () => {
    const v = run('setTimeout(() => { void p().then(() => undefined); }, 100);');
    expect(v).toHaveLength(1);
  });

  it('flags an expression-bodied arrow returning a `.finally` chain', () => {
    const v = run('setImmediate(() => p().finally(() => undefined));');
    expect(v).toHaveLength(1);
  });

  it('flags a floating (non-void) chain statement in the callback', () => {
    const v = run('setInterval(() => { p().then(() => undefined); }, 100);');
    expect(v).toHaveLength(1);
  });

  it('ignores promise chains OUTSIDE a timer callback', () => {
    const v = run('function f(): void { void p().finally(() => undefined); }');
    expect(v).toHaveLength(0);
  });

  it('does not attribute a nested function inside the callback to the timer', () => {
    const v = run(
      'setInterval(() => { const inner = () => { void p().finally(() => undefined); }; void inner; }, 100);',
    );
    expect(v).toHaveLength(0);
  });

  it('skips test files via the check wrapper', () => {
    // The exported detection has no test-file skip; the check wraps it with one.
    const flagged = analyzeTimerCallbacks(
      PRE + 'setInterval(() => { void p().finally(() => undefined); }, 100);',
      'src/example.test.ts',
    );
    // Detection itself still flags (no path filter); the skip lives on the check.
    expect(flagged).toHaveLength(1);
  });
});
