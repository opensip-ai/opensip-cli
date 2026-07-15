/**
 * @fileoverview Extension-lifecycle journeys — the three FIXED fixtures only.
 *
 * `whole-tool` and `fit-pack` are command-only journeys whose `commandSteps` are
 * the SHARED source for the release-smoke projection AND their own executors, so
 * the packed smoke and native acceptance run byte-identical assertions. They run
 * in the shared, initialized project (`isolated: false`), exactly as the packed
 * smoke runs every scenario in one consumer cwd. `sim-pack` is a bespoke,
 * isolated journey (it owns a fresh project): install → run the contributed
 * recipe → remove → prove the capability is gone.
 *
 * No external scanner executable appears here — each needs its own later
 * qualification profile.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expectEnvelope } from '../../cli-acceptance-core.mjs';
import {
  assertCommand,
  assertUniqueJourneyIds,
  defineJourney,
  fail,
  makeCommandExecutor,
  pass,
  runCli,
} from '../journey-kit.mjs';

const cmdData = (parsed) => parsed?.data ?? parsed;

// Installed npm tools are deny-by-default; the fixture id must be allowlisted for
// the post-install scenarios that mount/run it in the host process.
const ALLOW_INSTALLED_ENV = Object.freeze({ OPENSIP_CLI_ALLOW_INSTALLED_TOOLS: 'audit-demo-tool' });

/** The whole-Tool lifecycle steps (install → run → list → validate → uninstall → gone). */
const wholeToolSteps = (params) => [
  {
    slug: 'tools-install',
    name: 'tools install <tool-plugin> --project --json',
    args: ['tools', 'install', params.toolPluginTarball, '--project', '--json'],
    env: ALLOW_INSTALLED_ENV,
    timeout: 120_000,
    expect: {
      exitCode: 0,
      json: (parsed) => {
        const data = cmdData(parsed);
        return data?.success === true
          ? []
          : [
              `tools-install.success: expected true, got ${JSON.stringify(data?.success)} (${JSON.stringify(data?.error)})`,
            ];
      },
    },
  },
  {
    slug: 'audit-demo-run',
    name: 'audit-demo subcommand contributed by the tool plugin runs',
    args: ['audit-demo'],
    env: ALLOW_INSTALLED_ENV,
    expect: { exitCode: 0, stdoutIncludes: 'audit-demo ran' },
  },
  {
    slug: 'tools-list',
    name: 'tools list --json shows bundled ids + the installed fixture row',
    args: ['tools', 'list', '--json'],
    env: ALLOW_INSTALLED_ENV,
    expect: {
      exitCode: 0,
      json: (parsed) => {
        const failures = [];
        const data = cmdData(parsed);
        const rows = Array.isArray(data?.tools) ? data.tools : [];
        const ids = new Set(rows.map((t) => t?.id));
        for (const bundled of ['fitness', 'simulation', 'graph']) {
          if (!ids.has(bundled)) failures.push(`tools list: missing bundled id '${bundled}'`);
        }
        const fixture = rows.find((t) => t?.id === 'audit-demo-tool');
        if (fixture === undefined) {
          failures.push('tools list: missing the installed audit-demo-tool row');
        } else if (fixture.source !== 'project') {
          failures.push(
            `tools list: audit-demo-tool source: expected 'project', got ${JSON.stringify(fixture.source)}`,
          );
        }
        return failures;
      },
    },
  },
  {
    slug: 'tools-validate',
    name: 'tools validate <tool fixture tarball> passes every section',
    args: ['tools', 'validate', params.toolPluginTarball, '--json'],
    env: ALLOW_INSTALLED_ENV,
    timeout: 120_000,
    expect: {
      exitCode: 0,
      json: (parsed) => {
        const data = cmdData(parsed);
        return data?.verdict === 'passed'
          ? []
          : [`tools-validate.verdict: expected 'passed', got ${JSON.stringify(data?.verdict)}`];
      },
    },
  },
  {
    slug: 'tools-uninstall',
    name: 'tools uninstall removes the project-local fixture',
    args: ['tools', 'uninstall', 'audit-demo-tool', '--project', '--json'],
    env: ALLOW_INSTALLED_ENV,
    expect: {
      exitCode: 0,
      json: (parsed) => {
        const data = cmdData(parsed);
        return data?.success === true
          ? []
          : [
              `tools-uninstall.success: expected true, got ${JSON.stringify(data?.success)} (${JSON.stringify(data?.error)})`,
            ];
      },
    },
  },
  {
    slug: 'tools-list-gone',
    name: 'tools list --json no longer shows the fixture row',
    args: ['tools', 'list', '--json'],
    env: ALLOW_INSTALLED_ENV,
    expect: {
      exitCode: 0,
      json: (parsed) => {
        const data = cmdData(parsed);
        const rows = Array.isArray(data?.tools) ? data.tools : [];
        return rows.some((t) => t?.id === 'audit-demo-tool')
          ? ['tools list: audit-demo-tool row still present after uninstall']
          : [];
      },
    },
  },
];

/** The fit-pack lifecycle steps (install → narrow fit --check to the contributed slug). */
const fitPackSteps = (params) => [
  {
    slug: 'fit-plugin-add',
    name: 'fit plugin add <fit-pack> --json',
    args: ['fit', 'plugin', 'add', params.fitPackTarball, '--json'],
    timeout: 120_000,
    setup: ({ cwd }) => {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      writeFileSync(join(cwd, 'src', 'marker.ts'), 'export const m = "FIT_PACK_FIXTURE";\n');
    },
    expect: {
      exitCode: 0,
      json: (parsed) => {
        const data = cmdData(parsed);
        return data?.success === true
          ? []
          : [
              `fit-plugin-add.success: expected true, got ${JSON.stringify(data?.success)} (${JSON.stringify(data?.error)})`,
            ];
      },
    },
  },
  {
    slug: 'fit-pack-check',
    name: 'fit --json --check <fit-pack-slug> narrows to the contributed check',
    args: ['fit', '--json', '--check', 'fit-pack-fixture-marker'],
    expect: {
      exitCode: 1,
      json: (parsed) => {
        const failures = expectEnvelope({ tool: 'fit' })(parsed);
        const env = parsed?.envelope ?? parsed;
        const total = env?.verdict?.summary?.total;
        if (total !== 1)
          failures.push(`fit verdict.summary.total: expected 1, got ${JSON.stringify(total)}`);
        const signals = Array.isArray(env?.signals) ? env.signals : [];
        if (!signals.some((s) => s?.source === 'fit-pack-fixture-marker')) {
          failures.push('fit signals: expected a fit-pack-fixture-marker signal');
        }
        return failures;
      },
    },
  },
];

const simPackExecutor = async (context) => {
  const cwd = context.paths.workRoot;
  const init = await runCli(context, { args: ['init', '--language', 'typescript', '--json'], cwd });
  if (init.timedOut || (init.status ?? 1) !== 0)
    return fail('init-failed', [context.assert.diagnostic(init.stderrTail)]);

  const added = await runCli(context, {
    args: ['sim', 'plugin', 'add', context.fixtures.simPackTarball, '--json'],
    cwd,
    timeoutMs: 120_000,
  });
  const addOutcome = assertCommand(
    context,
    added,
    {
      exitCode: 0,
      json: (parsed) =>
        cmdData(parsed)?.success === true
          ? []
          : [
              `sim plugin add success: expected true, got ${JSON.stringify(cmdData(parsed)?.success)}`,
            ],
    },
    'sim-pack-add-failed',
  );
  if (addOutcome.status !== 'pass') return addOutcome;

  const ran = await runCli(context, {
    args: ['sim', '--recipe', 'sim-pack-fixture', '--json'],
    cwd,
  });
  const runOutcome = assertCommand(
    context,
    ran,
    { exitCode: 0, json: expectEnvelope({ tool: 'sim' }) },
    'sim-pack-run-failed',
  );
  if (runOutcome.status !== 'pass') return runOutcome;

  const removed = await runCli(context, {
    args: ['sim', 'plugin', 'remove', '@opensip-cli-fixture/sim-pack-demo', '--json'],
    cwd,
  });
  const removeOutcome = assertCommand(context, removed, { exitCode: 0 }, 'sim-pack-remove-failed');
  if (removeOutcome.status !== 'pass') return removeOutcome;

  // Prove the contributed capability is gone: the recipe no longer resolves.
  const afterRemoval = await runCli(context, {
    args: ['sim', '--recipe', 'sim-pack-fixture', '--json'],
    cwd,
  });
  if (afterRemoval.timedOut)
    return fail('timed-out', [context.assert.diagnostic('post-removal run timed out')]);
  if ((afterRemoval.status ?? 0) === 0) {
    return fail('sim-pack-still-present', [
      context.assert.diagnostic('the sim-pack-fixture recipe still ran after removal'),
    ]);
  }
  return pass();
};

export const extensionsJourneys = assertUniqueJourneyIds([
  defineJourney({
    id: 'extensions.whole-tool',
    category: 'extensions',
    value: {
      human: 'Install and run a whole-Tool plugin',
      agent: 'tools install/list/validate/run/uninstall lifecycle for a kind:tool package',
    },
    steps: [
      { label: 'tools install --project' },
      { label: 'run the contributed subcommand' },
      { label: 'tools list shows the fixture' },
      { label: 'tools validate the tarball' },
      { label: 'tools uninstall' },
      { label: 'tools list no longer shows the fixture' },
    ],
    commandSteps: wholeToolSteps,
    executor: makeCommandExecutor(wholeToolSteps),
  }),
  defineJourney({
    id: 'extensions.fit-pack',
    category: 'extensions',
    value: {
      human: 'Install and run a fit-pack',
      agent: 'fit plugin add then fit --check narrows to the contributed check',
    },
    steps: [
      { label: 'seed a marker file' },
      { label: 'fit plugin add' },
      { label: 'fit --check <contributed slug>' },
    ],
    commandSteps: fitPackSteps,
    executor: makeCommandExecutor(fitPackSteps),
  }),
  defineJourney({
    id: 'extensions.sim-pack',
    category: 'extensions',
    value: {
      human: 'Install and run a sim-pack',
      agent: 'sim plugin add → run recipe → remove → capability gone',
    },
    isolated: true,
    steps: [
      { label: 'init a fresh project' },
      { label: 'sim plugin add' },
      { label: 'run sim --recipe' },
      { label: 'sim plugin remove' },
      { label: 'prove the recipe is gone' },
    ],
    executor: simPackExecutor,
  }),
]);
