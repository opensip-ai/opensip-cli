/**
 * Embedded-render mode — a per-async-context flag marking that the current run is
 * executing as an EMBEDDED step of a larger host render (a suite step). In this
 * mode a tool's own terminal chrome (banner + live view + static result) must be
 * SUPPRESSED and the tool must run HEADLESS: its work still runs and its envelope
 * is still captured (via the documented egress seams), but it emits nothing to the
 * terminal — the host owns the visible output (one banner, one suite live view).
 *
 * The suite orchestrator sets this around each step; the render seams read it —
 * cli-live's `runToolLiveView` runs `produce()` without Ink, and the host `render`
 * seam skips the write. Because the signal is read at the HOST render seams that
 * EVERY tool funnels through (only-documented-toolcli-seams, ADR-0051), any tool —
 * bundled, `tool-*`, or a customer's — inherits headless-in-suite for free, with
 * no per-tool code.
 *
 * Backed by an AsyncLocalStorage so it flows to the step's async descendants and
 * auto-resets when the step completes — never module-level mutable run state
 * (see the RunScope discipline).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const embeddedRenderStorage = new AsyncLocalStorage<true>();

/** True when the current async context is an embedded step (suppress chrome; run headless). */
export function isEmbeddedRender(): boolean {
  return embeddedRenderStorage.getStore() === true;
}

/** Run `fn` and its async descendants in embedded-render mode. */
export function runEmbeddedRender<T>(fn: () => T): T {
  return embeddedRenderStorage.run(true, fn);
}
