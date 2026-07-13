import { afterEach, describe, expect, it } from 'vitest';

import { buildDeterministicEnv } from './env.js';

const original = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, original);
});

describe('buildDeterministicEnv', () => {
  it('sets deterministic controls and an isolated config home', () => {
    const home = `${process.cwd()}/.agent-eval-test-home`;
    const env = buildDeterministicEnv({ HOME: home });
    expect(env).toMatchObject({
      CI: '1',
      APPDATA: `${home}/AppData/Roaming`,
      HOME: home,
      HOMEDRIVE: '',
      HOMEPATH: home,
      LOCALAPPDATA: `${home}/AppData/Local`,
      LOGNAME: 'opensip-agent-eval',
      NO_COLOR: '1',
      OPENSIP_CLI_SKIP_INSTALLED: '1',
      OPENSIP_NO_UPDATE: '1',
      OPENSIP_PROFILING: '0',
      TERM: 'dumb',
      USER: 'opensip-agent-eval',
      USERNAME: 'opensip-agent-eval',
      USERPROFILE: home,
      XDG_CONFIG_HOME: `${home}/.config`,
    });
  });

  it('strips ambient authority, secrets, mutation posture, telemetry, and correlation', () => {
    Object.assign(process.env, {
      FORCE_COLOR: '1',
      OPENSIP_API_KEY: 'canary-not-a-real-secret',
      OPENSIP_MCP_ALLOW_MUTATIONS: '1',
      OPENSIP_CLI_SKIP_BUNDLED: '1',
      OPENSIP_RUN_ID: 'ambient-run',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://invalid.example',
      TRACEPARENT: '00-ambient',
      APPDATA: 'C:\\Users\\operator\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\operator\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\operator',
    });
    const env = buildDeterministicEnv({
      OPENSIP_MCP_ALLOW_MUTATIONS: '1',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://override.invalid',
    });
    expect(env.OPENSIP_API_KEY).toBeUndefined();
    expect(env.OPENSIP_MCP_ALLOW_MUTATIONS).toBeUndefined();
    expect(env.OPENSIP_CLI_SKIP_BUNDLED).toBeUndefined();
    expect(env.OPENSIP_RUN_ID).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(env.TRACEPARENT).toBeUndefined();
    expect(env.FORCE_COLOR).toBeUndefined();
    expect(env.APPDATA).toBe(`${env.HOME}/AppData/Roaming`);
    expect(env.LOCALAPPDATA).toBe(`${env.HOME}/AppData/Local`);
    expect(env.USERPROFILE).toBe(env.HOME);
  });
});
