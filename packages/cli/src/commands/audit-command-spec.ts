import { currentScope } from '@opensip-cli/core';

import {
  PROJECT_SCOPE,
  RAW_STREAM,
  defineCommand,
  type HostSpec,
} from './host-subcommand-shared.js';
import { BUILT_IN_AUDIT_SUITE, BUILT_IN_AUDIT_SUITE_NAME } from './suite/built-in-suites.js';
import { executeSuiteCommand } from './suite/execute-suite-command.js';
import { maybeOpenSuiteReport } from './suite/open-suite-report.js';
import { SUITE_RUN_OPTIONS } from './suite/suite-run-options.js';

import type { CliCommandsContext } from './shared.js';

const AUDIT_SUITE_OPTION_KEYS = [
  'cwd',
  'json',
  'quiet',
  'verbose',
  'debug',
  'config',
  'changed',
  'since',
  'files',
  'full',
] as const;

function suiteOptsForAudit(
  opts: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const suiteOpts: Record<string, unknown> = {};
  for (const key of AUDIT_SUITE_OPTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(opts, key)) suiteOpts[key] = opts[key];
  }
  return suiteOpts;
}

/** Build the curated changed-code review shortcut backed by the built-in audit suite. */
export function buildAuditCommandSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    staticHandler: {
      package: 'opensip-cli',
      path: 'packages/cli/src/commands/audit-command-spec.ts',
      declaration: 'buildAuditCommandSpec',
    },
    name: BUILT_IN_AUDIT_SUITE_NAME,
    description: 'Review changed-code risk, graph impact, and evidence quality',
    commonFlags: ['cwd', 'json', 'quiet', 'verbose', 'debug', 'open'],
    options: SUITE_RUN_OPTIONS,
    scope: PROJECT_SCOPE,
    // First value before first config: `audit` is the canonical first-run
    // command (ADR-0155) and must work on a repo that has never been
    // initialized, exactly like the `suite run audit` spelling it is equivalent
    // to (ADR-0159). The run is backed by an ephemeral user-cache runtime, so
    // nothing is written into the user's project until they run `init`.
    noInit: true,
    output: RAW_STREAM,
    rawStreamReason: 'runtime-render-dispatch',
    handler: async (rawOpts) => {
      const opts = rawOpts as Readonly<Record<string, unknown>>;
      const result = await executeSuiteCommand({
        name: BUILT_IN_AUDIT_SUITE_NAME,
        resolved: { suite: BUILT_IN_AUDIT_SUITE, source: 'built-in' },
        opts: suiteOptsForAudit(opts),
        ctx,
        tools: currentScope()?.tools.list() ?? [],
        defaultChanged: true,
      });
      if (result === undefined) return;
      return maybeOpenSuiteReport({
        name: BUILT_IN_AUDIT_SUITE_NAME,
        result,
        // Preserve the original opts so --open / --json are visible even though
        // they are stripped from the suite executor option bag.
        opts,
        ctx,
      });
    },
  });
}
