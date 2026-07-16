import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PASSTHROUGH_KEYS = [
  'COMSPEC',
  'LANG',
  'LC_ALL',
  'PATH',
  'PATHEXT',
  'SHELL',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'WINDIR',
] as const;

const FIXED_ENV = {
  CI: '1',
  NO_COLOR: '1',
  OPENSIP_CLI_SKIP_INSTALLED: '1',
  OPENSIP_NO_UPDATE: '1',
  OPENSIP_PROFILING: '0',
} as const;

function isForbiddenOverride(key: string): boolean {
  return (
    key === 'FORCE_COLOR' ||
    key === 'NODE_OPTIONS' ||
    key === 'TRACEPARENT' ||
    key === 'TRACESTATE' ||
    key.startsWith('OTEL_') ||
    (key.startsWith('OPENSIP_') && !(key in FIXED_ENV))
  );
}

/**
 * Build a small, deterministic child environment with no ambient OpenSIP,
 * plugin, cloud, correlation, profiling, or telemetry authority.
 */
export function buildDeterministicEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_KEYS) {
    const value =
      key === 'SYSTEMROOT' ? (process.env.SYSTEMROOT ?? process.env.SystemRoot) : process.env[key];
    if (value !== undefined) env[key] = value;
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && !isForbiddenOverride(key)) env[key] = value;
  }

  const home = overrides.HOME ?? join(tmpdir(), 'opensip-agent-eval-isolated-home');
  env.HOME = home;
  env.APPDATA = join(home, 'AppData', 'Roaming');
  env.HOMEDRIVE = '';
  env.HOMEPATH = home;
  env.LOCALAPPDATA = join(home, 'AppData', 'Local');
  env.LOGNAME = 'opensip-agent-eval';
  env.TERM = 'dumb';
  env.USER = 'opensip-agent-eval';
  env.USERNAME = 'opensip-agent-eval';
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = overrides.XDG_CONFIG_HOME ?? join(home, '.config');
  Object.assign(env, FIXED_ENV);
  return env;
}
