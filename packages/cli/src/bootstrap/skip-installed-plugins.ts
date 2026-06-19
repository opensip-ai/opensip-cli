/**
 * skip-installed-plugins — incident-response kill switch for ambient npm tool
 * discovery (architecture audit P0).
 *
 * Installed tools are discovered from ancestor `node_modules` during bootstrap,
 * before Commander parses. Both the env var and `--no-plugins` are therefore
 * read from `process.env` / raw argv — not from parsed Commander opts.
 */

/** Env var: any non-empty value skips installed npm tool discovery. */
export const SKIP_INSTALLED_PLUGINS_ENV = 'OPENSIP_CLI_SKIP_INSTALLED';

/**
 * True when argv contains `--no-plugins` anywhere (bootstrap runs before parse,
 * so the flag may appear before or after the subcommand verb).
 */
export function isNoPluginsArgvFlag(argv: readonly string[]): boolean {
  return argv.includes('--no-plugins');
}

/**
 * Should bootstrap skip `discoverAndRegisterToolPackages`?
 *
 * @param argv `process.argv.slice(2)` — user args after the binary.
 * @param env Injectable for tests (defaults to `process.env`).
 */
export function shouldSkipInstalledToolDiscovery(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isNoPluginsArgvFlag(argv)) return true;
  const raw = env[SKIP_INSTALLED_PLUGINS_ENV];
  return raw !== undefined && raw.length > 0;
}
