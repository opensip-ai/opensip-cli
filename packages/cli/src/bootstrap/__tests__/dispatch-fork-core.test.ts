/**
 * dispatch-fork-core child env — external-tool worker allow-list (spec 01).
 */

import { describe, expect, it } from 'vitest';

import {
  buildExternalWorkerChildEnv,
  EXTERNAL_WORKER_CHILD_ENV_ALLOWLIST,
  TOOL_ENV_PASSTHROUGH_ENV,
} from '../build-external-worker-child-env.js';
import { IN_TOOL_WORKER_ENV } from '../tool-provenance.js';

describe('buildExternalWorkerChildEnv', () => {
  it('forwards allow-list vars and host-set worker markers but not arbitrary secrets', () => {
    const childEnv = buildExternalWorkerChildEnv({
      parentEnv: {
        PATH: '/usr/bin',
        HOME: '/home/user',
        MY_SECRET: 'super-secret',
        OPENSIP_API_KEY: 'key-should-not-forward',
      },
      runId: 'run_test_1',
      traceparent: '00-abc-def-01',
    });

    for (const key of EXTERNAL_WORKER_CHILD_ENV_ALLOWLIST) {
      if (key === 'PATH' || key === 'HOME') {
        expect(childEnv[key]).toBeDefined();
      }
    }
    expect(childEnv.PATH).toBe('/usr/bin');
    expect(childEnv.HOME).toBe('/home/user');
    expect(childEnv[IN_TOOL_WORKER_ENV]).toBe('1');
    expect(childEnv.OPENSIP_RUN_ID).toBe('run_test_1');
    expect(childEnv.TRACEPARENT).toBe('00-abc-def-01');
    expect(childEnv.MY_SECRET).toBeUndefined();
    expect(childEnv.OPENSIP_API_KEY).toBeUndefined();
  });

  it('forwards OPENSIP_CLI_TOOL_ENV_PASSTHROUGH-listed vars from the parent', () => {
    const childEnv = buildExternalWorkerChildEnv({
      parentEnv: {
        PATH: '/bin',
        [TOOL_ENV_PASSTHROUGH_ENV]: 'HTTP_PROXY, MY_CUSTOM_VAR',
        HTTP_PROXY: 'http://proxy:8080',
        MY_CUSTOM_VAR: 'needed-by-tool',
        MY_SECRET: 'still-blocked',
      },
    });

    expect(childEnv.HTTP_PROXY).toBe('http://proxy:8080');
    expect(childEnv.MY_CUSTOM_VAR).toBe('needed-by-tool');
    expect(childEnv.MY_SECRET).toBeUndefined();
  });

  it('omits TRACEPARENT when no recording span is active', () => {
    const childEnv = buildExternalWorkerChildEnv({
      parentEnv: { PATH: '/bin' },
      traceparent: undefined,
    });

    expect(childEnv.TRACEPARENT).toBeUndefined();
  });

  it('does not inherit TRACEPARENT from the parent env', () => {
    const childEnv = buildExternalWorkerChildEnv({
      parentEnv: { PATH: '/bin', TRACEPARENT: '00-stale-from-parent-01' },
      traceparent: '00-active-span-01',
    });

    expect(childEnv.TRACEPARENT).toBe('00-active-span-01');
  });
});
