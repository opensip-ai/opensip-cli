/**
 * `tools data-purge` (plan phase 7.5 + the live id-form bug): the stores key
 * inconsistently (sessions use the SHORT id 'fit'; the baseline plane the
 * LONG id 'fitness') — purging either form must clear all of them. Caught
 * live: purging 'fitness' missed a 'fit' session.
 */

import {
  BASELINE_FORMAT_VERSION,
  TOOL_LONG_TO_SHORT,
  ToolRegistry,
  type BaselineIdentityMetadata,
  type Tool,
  type ToolIdentity,
} from '@opensip-cli/core';
import { BaselineRepo, DataStoreFactory, ToolStateRepo } from '@opensip-cli/datastore';
import { SessionRepo } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveToolDataPurgeIdForms, toolsDataPurge } from '../commands/tools/data-purge.js';

import type { StoredSession } from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';

/** Local test fixture — not a runtime export. */
const DEFAULT_TEST_BASELINE_IDENTITY: BaselineIdentityMetadata = {
  baselineFormatVersion: BASELINE_FORMAT_VERSION,
  fingerprintStrategyId: 'opensip.default.rule-file-line-col',
  fingerprintStrategyVersion: 1,
};

let ds: DataStore;

beforeEach(() => {
  ds = DataStoreFactory.open({ backend: 'memory' });
});

afterEach(() => {
  ds.close();
});

function fitSession(id: string): StoredSession {
  return {
    id,
    tool: 'fit',
    startedAt: '2026-06-12T00:00:00.000Z',
    completedAt: '2026-06-12T00:00:00.000Z',
    cwd: '/tmp',
    recipe: 'default',
    score: 100,
    passed: true,
    durationMs: 10,
    payload: {
      summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 },
      checks: [],
    },
  };
}

function testTool(identity: ToolIdentity): Tool {
  return {
    identity,
    metadata: {
      id: `stable-${identity.name}`,
      name: identity.name,
      version: '0.0.0-test',
      description: 'test tool',
    },
  };
}

function registryWithBundledTools(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const [name, layoutKey] of Object.entries(TOOL_LONG_TO_SHORT)) {
    registry.register(
      testTool({
        name,
        aliases: layoutKey === name ? [] : [layoutKey],
        layoutKey,
      }),
    );
  }
  return registry;
}

describe('toolsDataPurge', () => {
  it('derives bundled id forms from registered tool identity', () => {
    const registry = registryWithBundledTools();

    expect(deriveToolDataPurgeIdForms('fitness', registry)).toEqual(['fitness', 'fit']);
    expect(deriveToolDataPurgeIdForms('fit', registry)).toEqual(['fitness', 'fit']);
    expect(deriveToolDataPurgeIdForms('simulation', registry)).toEqual(['simulation', 'sim']);
    expect(deriveToolDataPurgeIdForms('sim', registry)).toEqual(['simulation', 'sim']);
    expect(deriveToolDataPurgeIdForms('graph', registry)).toEqual(['graph']);
  });

  it('purging the LONG id clears the SHORT-keyed sessions + LONG-keyed baselines + state', () => {
    new SessionRepo(ds).save(fitSession('FIT_A'));
    new BaselineRepo(ds).save('fitness', [], DEFAULT_TEST_BASELINE_IDENTITY);
    new ToolStateRepo(ds).put('fitness', 'k', { v: 1 });

    const result = toolsDataPurge('fitness', ds, ['fitness', 'fit']);
    expect(result.sessions).toBe(1);
    expect(result.baselineMeta).toBe(true);
    expect(result.stateRows).toBe(1);
    expect(new SessionRepo(ds).count()).toBe(0);
    expect(new BaselineRepo(ds).exists('fitness')).toBe(false);
  });

  it('purging the SHORT id clears the same set', () => {
    new SessionRepo(ds).save(fitSession('FIT_B'));
    new BaselineRepo(ds).save('fitness', [], DEFAULT_TEST_BASELINE_IDENTITY);
    new ToolStateRepo(ds).put('fit', 'short', { v: 1 });
    new ToolStateRepo(ds).put('fitness', 'long', { v: 2 });

    const result = toolsDataPurge('fit', ds, ['fitness', 'fit']);
    expect(result.sessions).toBe(1);
    expect(result.baselineMeta).toBe(true);
    expect(result.stateRows).toBe(2);
    expect(new BaselineRepo(ds).exists('fitness')).toBe(false);
  });

  it('third-party ids purge under their own single form, never touching others', () => {
    new SessionRepo(ds).save(fitSession('FIT_C'));
    new ToolStateRepo(ds).put('acme-audit', 'k', 1);

    const result = toolsDataPurge('acme-audit', ds);
    expect(result.stateRows).toBe(1);
    expect(result.sessions).toBe(0);
    expect(new SessionRepo(ds).count()).toBe(1);
  });
});
