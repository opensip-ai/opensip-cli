import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { logger } from '@opensip-cli/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createResolutionTrace } from '../resolution-trace.js';

const roots: string[] = [];
const originalSiteLog = process.env.GRAPH_SITE_LOG;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalSiteLog === undefined) delete process.env.GRAPH_SITE_LOG;
  else process.env.GRAPH_SITE_LOG = originalSiteLog;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('createResolutionTrace', () => {
  it('latches off after the first write failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'graph-resolution-trace-fault-'));
    roots.push(root);
    process.env.GRAPH_SITE_LOG = join(root, 'missing', 'trace.tsv');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const trace = createResolutionTrace();
    expect(trace).toBeDefined();

    trace?.append(['first']);
    trace?.append(['second']);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'graph.resolution_trace.disabled',
        condition: 'write-failed',
      }),
    );
  });

  it('removes row-breaking control characters from trace fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'graph-resolution-trace-safe-'));
    roots.push(root);
    const tracePath = join(root, 'trace.tsv');
    process.env.GRAPH_SITE_LOG = tracePath;

    createResolutionTrace()?.append(['owner\tfield', 'callee\nname']);

    expect(readFileSync(tracePath, 'utf8')).toBe('owner field\tcallee name\n');
  });
});
