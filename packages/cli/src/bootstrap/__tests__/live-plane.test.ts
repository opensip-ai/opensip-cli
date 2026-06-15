/**
 * Narrow unit coverage for the live plane (host-owned-run-timing Phase 6 §6.1 /
 * Task 6.2). The pure registry (`createLiveViewRegistry`) is covered alongside
 * `buildToolCliContext` in cli-context.test.ts; here we focus on
 * `createLivePlane` — that `renderLive` runs the render through the run plane's
 * `completeLiveRender` and always supplies the host `LiveViewContext` (carrying
 * the run seam) as the renderer's second argument.
 */

import { describe, expect, it, vi } from 'vitest';

import { createLivePlane, createLiveViewRegistry } from '../live-plane.js';
import { createRunPlaneFactory, createRunSessionSeam } from '../run-plane.js';

import type { Logger, LiveViewRenderer } from '@opensip-cli/core';

const SILENT: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makePlaneDeps() {
  const runPlane = createRunPlaneFactory({ getDatastore: () => undefined, logger: SILENT });
  const runSession = createRunSessionSeam(runPlane);
  const liveViews = createLiveViewRegistry(SILENT);
  return { runPlane, runSession, liveViews };
}

describe('createLivePlane', () => {
  it('register forwards to the underlying registry', () => {
    const deps = makePlaneDeps();
    const plane = createLivePlane(deps);
    const renderer = vi.fn<LiveViewRenderer>(() => Promise.resolve());
    plane.register('view-x', renderer);
    expect(deps.liveViews.has('view-x')).toBe(true);
  });

  it('renderLive supplies the default LiveViewContext (host run seam) as the 2nd arg', async () => {
    const deps = makePlaneDeps();
    const plane = createLivePlane(deps);
    const renderer = vi.fn<LiveViewRenderer>(() => Promise.resolve());
    plane.register('fake', renderer);

    await plane.renderLive('fake', { v: 1 });

    expect(renderer).toHaveBeenCalledWith(
      { v: 1 },
      expect.objectContaining({ runSession: deps.runSession }),
    );
  });

  it('renderLive forwards an explicit LiveViewContext unchanged', async () => {
    const deps = makePlaneDeps();
    const plane = createLivePlane(deps);
    const renderer = vi.fn<LiveViewRenderer>(() => Promise.resolve());
    plane.register('fake', renderer);

    const explicit = { runSession: deps.runSession };
    await plane.renderLive('fake', { v: 2 }, explicit);

    expect(renderer).toHaveBeenCalledWith({ v: 2 }, explicit);
  });

  it('renderLive returns the renderer completion (run plane completes it)', async () => {
    const deps = makePlaneDeps();
    const plane = createLivePlane(deps);
    const completion = { session: undefined };
    plane.register('fake', () => Promise.resolve(completion));

    const out = await plane.renderLive('fake', {});
    expect(out).toBe(completion);
  });
});
