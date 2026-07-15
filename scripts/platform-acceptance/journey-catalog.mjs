/**
 * @fileoverview The platform-acceptance common journey catalog.
 *
 * This is the ONE closed inventory of human + agent customer journeys. The six
 * lifecycle journeys are defined here (they are produced by the runner's
 * CandidateLifecycle orchestration or are plain CLI commands); the other 40 come
 * from the domain modules under `journeys/`. `common-v1.json` selects ids from
 * this registry and Phase 3 resolves them in profile order; a profile can never
 * reference an unregistered id (`resolveProfileJourneys` throws), and profile
 * data can never inject argv/env/code — argv lives only in journey code.
 *
 * The registry MUST hold exactly the `common-v1` id set (validated at module
 * load). The release-smoke selection is the command-only subset the packed
 * smoke projects; its scenarios ARE the catalog source, so packed smoke and
 * native acceptance run byte-identical assertions.
 *
 * Types + the Phase 3 handoff contract live in `journey-catalog.d.mts`.
 */

import { analysisJourneys } from './journeys/analysis.mjs';
import { extensionsJourneys } from './journeys/extensions.mjs';
import { agentJourneys, mcpJourneys } from './journeys/mcp.mjs';
import { outputJourneys } from './journeys/output.mjs';
import { persistenceJourneys } from './journeys/persistence.mjs';
import { resilienceJourneys } from './journeys/resilience.mjs';
import {
  defineJourney,
  fail,
  makeCommandExecutor,
  pass,
  runCli,
  unavailable,
} from './journey-kit.mjs';

// ---------------------------------------------------------------------------
// Lifecycle journeys (defined here — tied to the CandidateLifecycle / plain CLI)
// ---------------------------------------------------------------------------

const versionSteps = (params) => [
  {
    slug: 'version',
    name: '--version reports the consensus release version',
    args: ['--version'],
    expect: { exitCode: 0, stdoutIncludes: params.expectedVersion },
  },
];

const helpSteps = () => [
  {
    slug: 'help-commands',
    name: '--help mounts the full command tree',
    args: ['--help'],
    expect: { exitCode: 0, stdoutIncludes: 'Commands:' },
  },
  {
    slug: 'help-fit',
    name: '--help lists the fit subcommand',
    args: ['--help'],
    expect: { exitCode: 0, stdoutIncludes: 'fit' },
  },
];

/** Post-install usability fallback (the runner normally sources install from the transition). */
const installFallbackExecutor = async (context) => {
  const result = await runCli(context, { args: ['--version'] });
  if (result.timedOut) return fail('timed-out', [context.assert.diagnostic(result.stderrTail)]);
  if ((result.status ?? 1) !== 0)
    return fail('installed-cli-unusable', [
      context.assert.diagnostic(`--version exited ${result.status}`),
    ]);
  if (result.stdoutCapture.trim().length === 0)
    return fail('no-version-output', [context.assert.diagnostic('--version produced no output')]);
  return pass();
};

/** Fail-closed fallback for the transitions only the CandidateLifecycle can drive. */
const lifecycleDrivenFallback = (context) =>
  Promise.resolve(
    unavailable('lifecycle-driven', [
      context.assert.diagnostic(
        'produced by the runner CandidateLifecycle orchestration, not the port',
      ),
    ]),
  );

const lifecycleJourneys = [
  defineJourney({
    id: 'lifecycle.install',
    category: 'lifecycle',
    value: {
      human: 'Install and it just runs',
      agent: 'the installed candidate answers --version',
    },
    lifecycleDriven: true,
    isolated: true,
    steps: [
      { label: 'install the verified candidate' },
      { label: 'assert the installed CLI is usable' },
    ],
    executor: installFallbackExecutor,
  }),
  defineJourney({
    id: 'lifecycle.version',
    category: 'lifecycle',
    value: { human: 'Know the version', agent: '--version reports the resolved candidate version' },
    steps: [{ label: 'run --version' }],
    commandSteps: versionSteps,
    executor: makeCommandExecutor(versionSteps),
  }),
  defineJourney({
    id: 'lifecycle.help',
    category: 'lifecycle',
    value: { human: 'Discover commands', agent: '--help mounts the full command tree incl. fit' },
    steps: [{ label: 'run --help' }, { label: 'assert the command tree + fit' }],
    commandSteps: helpSteps,
    executor: makeCommandExecutor(helpSteps),
  }),
  defineJourney({
    id: 'lifecycle.upgrade',
    category: 'lifecycle',
    value: {
      human: 'Upgrade in place',
      agent: 'reinstalling a newer candidate migrates version + state',
    },
    lifecycleDriven: true,
    isolated: true,
    steps: [
      { label: 'reinstall a newer candidate' },
      { label: 'assert version + state migration' },
    ],
    executor: lifecycleDrivenFallback,
  }),
  defineJourney({
    id: 'lifecycle.cli-state-uninstall',
    category: 'lifecycle',
    value: {
      human: 'Remove OpenSIP state',
      agent: 'opensip uninstall removes only its state, leaves the package',
    },
    lifecycleDriven: true,
    isolated: true,
    steps: [{ label: 'run opensip uninstall' }, { label: 'assert only CLI state removed' }],
    executor: lifecycleDrivenFallback,
  }),
  defineJourney({
    id: 'lifecycle.package-uninstall',
    category: 'lifecycle',
    value: {
      human: 'Uninstall the package',
      agent: 'npm uninstall removes the shim + entrypoint entirely',
    },
    lifecycleDriven: true,
    isolated: true,
    steps: [{ label: 'run npm uninstall' }, { label: 'assert the shim + entrypoint are gone' }],
    executor: lifecycleDrivenFallback,
  }),
];

// ---------------------------------------------------------------------------
// Registry assembly
// ---------------------------------------------------------------------------

const ALL_JOURNEYS = [
  ...lifecycleJourneys,
  ...analysisJourneys,
  ...outputJourneys,
  ...persistenceJourneys,
  ...mcpJourneys,
  ...agentJourneys,
  ...extensionsJourneys,
  ...resilienceJourneys,
];

/**
 * The explicit `common-v1` selection — all 46 ids, in profile order. A load-time
 * assertion binds this to the registry (bijection) so drift fails fast.
 */
export const COMMON_V1_JOURNEY_IDS = Object.freeze([
  'lifecycle.install',
  'lifecycle.version',
  'lifecycle.help',
  'analysis.audit-preinit',
  'analysis.init',
  'analysis.fit',
  'analysis.graph',
  'analysis.graph-impact',
  'analysis.sim',
  'analysis.yagni',
  'analysis.report',
  'analysis.sessions-list',
  'analysis.sessions-show',
  'analysis.replay',
  'output.human-non-tty',
  'output.no-color',
  'output.json',
  'output.filters-raw',
  'output.sarif',
  'output.report-html',
  'output.pty',
  'persistence.sqlite-load',
  'persistence.first-open-migration',
  'persistence.cross-process-replay',
  'persistence.contention-retry',
  'persistence.interrupted-recovery',
  'persistence.state-bounds',
  'mcp.initialize',
  'mcp.catalog-parity',
  'mcp.context',
  'mcp.graph-reads',
  'mcp.result-replay',
  'mcp.stale-evidence',
  'agent.installed-smoke',
  'extensions.whole-tool',
  'extensions.fit-pack',
  'extensions.sim-pack',
  'resilience.spaces-unicode',
  'resilience.symlink-root',
  'resilience.permissions',
  'resilience.isolated-home',
  'resilience.signals',
  'resilience.timeout-cleanup',
  'lifecycle.upgrade',
  'lifecycle.cli-state-uninstall',
  'lifecycle.package-uninstall',
]);

/**
 * The explicit `release-smoke` selection — the command-only subset the packed
 * smoke projects, in projection order. Heavier MCP / contention / TTY /
 * resilience journeys are intentionally excluded.
 */
export const RELEASE_SMOKE_JOURNEY_IDS = Object.freeze([
  'lifecycle.version',
  'lifecycle.help',
  'analysis.init',
  'analysis.fit',
  'analysis.graph',
  'analysis.report',
  'analysis.sessions-list',
  'extensions.whole-tool',
  'extensions.fit-pack',
]);

function buildRegistry(journeys) {
  const registry = new Map();
  for (const journey of journeys) {
    if (registry.has(journey.id)) {
      throw new Error(`journey-catalog: duplicate journey id ${JSON.stringify(journey.id)}`);
    }
    registry.set(journey.id, journey);
  }
  // Bijection with the common-v1 selection: no missing, no extra id.
  const selected = new Set(COMMON_V1_JOURNEY_IDS);
  if (selected.size !== COMMON_V1_JOURNEY_IDS.length) {
    throw new Error('journey-catalog: COMMON_V1_JOURNEY_IDS contains a duplicate id');
  }
  for (const id of COMMON_V1_JOURNEY_IDS) {
    if (!registry.has(id))
      throw new Error(
        `journey-catalog: common-v1 selects unregistered journey ${JSON.stringify(id)}`,
      );
  }
  for (const id of registry.keys()) {
    if (!selected.has(id))
      throw new Error(
        `journey-catalog: registry holds ${JSON.stringify(id)} which common-v1 does not select`,
      );
  }
  // Every release-smoke id must be a registered, command-only journey.
  for (const id of RELEASE_SMOKE_JOURNEY_IDS) {
    const journey = registry.get(id);
    if (journey === undefined)
      throw new Error(
        `journey-catalog: release-smoke selects unregistered journey ${JSON.stringify(id)}`,
      );
    if (typeof journey.commandSteps !== 'function') {
      throw new TypeError(
        `journey-catalog: release-smoke journey ${JSON.stringify(id)} has no commandSteps`,
      );
    }
  }
  return registry;
}

/** The closed registry: id -> frozen journey row. */
export const JOURNEY_REGISTRY = buildRegistry(ALL_JOURNEYS);

/** Look up a registered journey by id (throws on an unregistered id). */
export function getJourney(id, registry = JOURNEY_REGISTRY) {
  const journey = registry.get(id);
  if (journey === undefined)
    throw new Error(`journey-catalog: no registered journey ${JSON.stringify(id)}`);
  return journey;
}

/**
 * Resolve a profile's selected ids to frozen rows, in profile order, against the
 * given registry (defaults to the built-in one; the runner passes its injected
 * registry so the journey-registry seam is honoured end to end).
 */
export function resolveProfileJourneys(ids, registry = JOURNEY_REGISTRY) {
  if (!Array.isArray(ids)) throw new TypeError('resolveProfileJourneys: ids must be an array');
  return Object.freeze(ids.map((id) => getJourney(id, registry)));
}

// ---------------------------------------------------------------------------
// Release-smoke projection (catalog -> Scenario[])
// ---------------------------------------------------------------------------

function toScenario(journeyId, step, cwd) {
  const scenario = {
    id: `${journeyId}#${step.slug}`,
    name: step.name,
    args: [...step.args],
    cwd,
    expect: step.expect,
  };
  if (step.env !== undefined) scenario.env = step.env;
  if (step.timeout !== undefined) scenario.timeout = step.timeout;
  if (step.setup !== undefined) scenario.setup = step.setup;
  return scenario;
}

/**
 * Project the release-smoke journeys into the ordered Scenario[] the packed
 * smoke runs. Each scenario carries a stable `id` (`<journeyId>#<slug>`).
 */
export function projectReleaseSmokeScenarios(params) {
  const scenarios = [];
  for (const id of RELEASE_SMOKE_JOURNEY_IDS) {
    const journey = getJourney(id);
    for (const step of journey.commandSteps(params)) {
      scenarios.push(toScenario(id, step, params.cwd));
    }
  }
  return scenarios;
}

/**
 * Assert every scenario maps to a registered release-smoke journey and the
 * projected set matches the catalog source exactly (ordered id, name, argv) — no
 * hand-authored drift. The assertion blocks cannot diverge because packed smoke
 * carries the projection's own `expect` through unchanged; a hand-authored
 * scenario would fail the id/name/argv match here. Throws on any mismatch.
 */
export function assertReleaseSmokeParity(scenarios, params) {
  const expected = projectReleaseSmokeScenarios(params);
  if (!Array.isArray(scenarios))
    throw new TypeError('assertReleaseSmokeParity: scenarios must be an array');
  if (scenarios.length !== expected.length) {
    throw new Error(
      `release-smoke parity: expected ${expected.length} scenarios, got ${scenarios.length}`,
    );
  }
  for (const [index, scenario] of scenarios.entries()) {
    const source = expected[index];
    const journeyId = typeof scenario.id === 'string' ? scenario.id.split('#')[0] : undefined;
    if (
      journeyId === undefined ||
      !JOURNEY_REGISTRY.has(journeyId) ||
      !RELEASE_SMOKE_JOURNEY_IDS.includes(journeyId)
    ) {
      throw new Error(
        `release-smoke parity: scenario ${index} id ${JSON.stringify(scenario.id)} does not map to a release-smoke journey`,
      );
    }
    if (scenario.id !== source.id)
      throw new Error(
        `release-smoke parity: scenario ${index} id ${JSON.stringify(scenario.id)} != catalog ${JSON.stringify(source.id)}`,
      );
    if (scenario.name !== source.name)
      throw new Error(
        `release-smoke parity: scenario ${JSON.stringify(scenario.id)} name diverges from the catalog source`,
      );
    if (JSON.stringify(scenario.args) !== JSON.stringify(source.args)) {
      throw new Error(
        `release-smoke parity: scenario ${JSON.stringify(scenario.id)} args diverge from the catalog source`,
      );
    }
    if (typeof scenario.expect !== 'object' || scenario.expect === null) {
      throw new Error(
        `release-smoke parity: scenario ${JSON.stringify(scenario.id)} is missing its assertion block`,
      );
    }
  }
}
