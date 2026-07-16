/**
 * @fileoverview Journey contribution API — the leaf shared by `journey-catalog.mjs`
 * and every domain module under `journeys/`.
 *
 * It is dependency-free apart from the sibling acceptance core (whose pure
 * assertion helpers it reuses, so journeys and packed smoke share ONE assertion
 * truth). Keeping this a leaf — it imports neither `journey-catalog.mjs` nor any
 * `journeys/*.mjs` — is what keeps the registry acyclic: domain modules build
 * their frozen rows through `defineJourney`, and the catalog folds those rows in.
 *
 * Design invariants (enforced here):
 *   - `defineJourney` freezes a row and rejects an unknown capability. A domain
 *     module fails to construct if it declares a capability outside the closed
 *     vocabulary, and `assertUniqueJourneyIds` rejects a duplicate id.
 *   - An executor uses ONLY its `JourneyExecutorContext`: it never spawns, never
 *     resolves a binary, never reads ambient `process.env`. `runCli` builds argv
 *     from the resolved installed descriptor it is handed; it does not discover
 *     one.
 *   - Outcomes are bounded. A non-`pass` status carries a kebab-case reason code.
 *
 * Types live in `journey-catalog.d.mts` — the single source of type truth and
 * the Phase 3 handoff contract.
 *
 * @typedef {import('./journey-catalog.d.mts').AcceptanceJourney} AcceptanceJourney
 * @typedef {import('./journey-catalog.d.mts').JourneyExecutorContext} JourneyExecutorContext
 * @typedef {import('./journey-catalog.d.mts').JourneyOutcome} JourneyOutcome
 * @typedef {import('./journey-catalog.d.mts').MeasuredProcessResult} MeasuredProcessResult
 * @typedef {import('./journey-catalog.d.mts').CommandStepSpec} CommandStepSpec
 * @typedef {import('./journey-catalog.d.mts').CommandStepParams} CommandStepParams
 */

import { resolveInstalledCliInvocation } from './node-cli-invocation.mjs';
import { PLATFORM_ACCEPTANCE_CAPABILITIES } from './contract.mjs';

/** The closed native-capability vocabulary. A journey may declare only these. */
export const KNOWN_CAPABILITIES = Object.freeze(new Set(PLATFORM_ACCEPTANCE_CAPABILITIES));

const KEBAB_REASON = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

const MAX_DIAGNOSTIC_LENGTH = 2048;
const MAX_DIAGNOSTICS = 16;

/** A typed construction error for a malformed journey row (a programmer bug). */
class JourneyDefinitionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JourneyDefinitionError';
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new JourneyDefinitionError(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Validate and freeze one journey row. Rejects a malformed id, an unknown
 * capability, a duplicate capability, or a missing executor.
 *
 * @param {object} row
 * @returns {AcceptanceJourney}
 */
export function defineJourney(row) {
  if (typeof row !== 'object' || row === null) {
    throw new JourneyDefinitionError('journey row must be an object');
  }
  const id = requireString(row.id, 'journey.id');
  if (!ID_PATTERN.test(id)) {
    throw new JourneyDefinitionError(`journey.id ${JSON.stringify(id)} is not a valid id`);
  }
  const category = requireString(row.category, `journey.category (${id})`);
  if (!id.startsWith(`${category}.`)) {
    throw new JourneyDefinitionError(
      `journey.id ${JSON.stringify(id)} must be namespaced under its category`,
    );
  }
  if (typeof row.value !== 'object' || row.value === null) {
    throw new JourneyDefinitionError(`journey.value (${id}) must be an object`);
  }
  requireString(row.value.human, `journey.value.human (${id})`);
  requireString(row.value.agent, `journey.value.agent (${id})`);

  const capabilitiesRaw = row.capabilities ?? [];
  if (!Array.isArray(capabilitiesRaw)) {
    throw new JourneyDefinitionError(`journey.capabilities (${id}) must be an array`);
  }
  const seenCapabilities = new Set();
  for (const capability of capabilitiesRaw) {
    if (!KNOWN_CAPABILITIES.has(capability)) {
      throw new JourneyDefinitionError(
        `journey ${JSON.stringify(id)} declares unknown capability ${JSON.stringify(capability)}`,
      );
    }
    if (seenCapabilities.has(capability)) {
      throw new JourneyDefinitionError(
        `journey ${JSON.stringify(id)} declares duplicate capability ${JSON.stringify(capability)}`,
      );
    }
    seenCapabilities.add(capability);
  }

  const stepsRaw = row.steps ?? [];
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    throw new JourneyDefinitionError(`journey.steps (${id}) must be a non-empty array`);
  }
  const steps = stepsRaw.map((step) =>
    Object.freeze({ label: requireString(step?.label, `journey.steps[].label (${id})`) }),
  );

  if (typeof row.executor !== 'function') {
    throw new JourneyDefinitionError(`journey.executor (${id}) must be a function`);
  }
  if (row.commandSteps !== undefined && typeof row.commandSteps !== 'function') {
    throw new JourneyDefinitionError(
      `journey.commandSteps (${id}), when present, must be a function`,
    );
  }

  const journey = {
    id,
    category,
    value: Object.freeze({ human: row.value.human, agent: row.value.agent }),
    capabilities: Object.freeze([...seenCapabilities]),
    steps: Object.freeze(steps),
    isolated: row.isolated === true,
    // Lifecycle-driven journeys (install/upgrade/cli-state/package removal) are
    // produced by the runner's CandidateLifecycle orchestration, not the port.
    // The executor is a fail-closed fallback (never a false pass).
    lifecycleDriven: row.lifecycleDriven === true,
    executor: row.executor,
  };
  if (row.commandSteps !== undefined) journey.commandSteps = row.commandSteps;
  return Object.freeze(journey);
}

/**
 * Freeze an ordered array of journeys after asserting the ids are unique. A
 * domain module calls this on its own contributions so it fails to construct on
 * a duplicate id.
 *
 * @param {readonly AcceptanceJourney[]} journeys
 * @returns {readonly AcceptanceJourney[]}
 */
export function assertUniqueJourneyIds(journeys) {
  const seen = new Set();
  for (const journey of journeys) {
    if (seen.has(journey.id)) {
      throw new JourneyDefinitionError(`duplicate journey id ${JSON.stringify(journey.id)}`);
    }
    seen.add(journey.id);
  }
  return Object.freeze([...journeys]);
}

// ---------------------------------------------------------------------------
// Outcome builders
// ---------------------------------------------------------------------------

function boundedDiagnostics(diagnostics) {
  const out = [];
  for (const entry of diagnostics ?? []) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    // eslint-disable-next-line no-control-regex
    const stripped = entry.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ');
    out.push(
      stripped.length > MAX_DIAGNOSTIC_LENGTH
        ? `…${stripped.slice(-MAX_DIAGNOSTIC_LENGTH)}`
        : stripped,
    );
    if (out.length >= MAX_DIAGNOSTICS) break;
  }
  return Object.freeze(out);
}

function requireReason(reasonCode, status) {
  if (typeof reasonCode !== 'string' || !KEBAB_REASON.test(reasonCode)) {
    throw new JourneyDefinitionError(`a ${status} outcome requires a kebab-case reasonCode`);
  }
  return reasonCode;
}

/** @returns {JourneyOutcome} */
export function pass(diagnostics = []) {
  return Object.freeze({
    status: 'pass',
    reasonCode: null,
    diagnostics: boundedDiagnostics(diagnostics),
  });
}

/** @returns {JourneyOutcome} */
export function fail(reasonCode, diagnostics = []) {
  return Object.freeze({
    status: 'fail',
    reasonCode: requireReason(reasonCode, 'fail'),
    diagnostics: boundedDiagnostics(diagnostics),
  });
}

/** @returns {JourneyOutcome} */
export function unavailable(reasonCode, diagnostics = []) {
  return Object.freeze({
    status: 'unavailable',
    reasonCode: requireReason(reasonCode, 'unavailable'),
    diagnostics: boundedDiagnostics(diagnostics),
  });
}

// ---------------------------------------------------------------------------
// Executor helpers (consume ONLY the injected context)
// ---------------------------------------------------------------------------

/**
 * Run the installed customer CLI once via the injected measured-process port.
 * argv is built from the resolved installed descriptors the context carries;
 * this never discovers a candidate binary. A Windows `.cmd` shim is represented
 * as `process.execPath` plus the validated package JS entrypoint, keeping the
 * measured-process port shell-free.
 *
 * @param {JourneyExecutorContext} context
 * @param {{ args: readonly string[], cwd?: string, env?: Record<string,string>, timeoutMs?: number, stdin?: string, signal?: AbortSignal, nativeSignal?: {signal:'SIGINT'|'SIGTERM',afterMs:number}, pty?: boolean }} options
 * @returns {Promise<MeasuredProcessResult>}
 */
export function runCli(context, options) {
  const invocation = resolveInstalledCliInvocation(context.installed);
  const spec = {
    argv: [invocation.command, ...invocation.prefixArgs, ...options.args],
    cwd: options.cwd ?? context.paths.workRoot,
  };
  if (options.env !== undefined) spec.env = options.env;
  if (options.timeoutMs !== undefined) spec.timeoutMs = options.timeoutMs;
  if (options.stdin !== undefined) spec.stdin = options.stdin;
  if (options.signal !== undefined) spec.signal = options.signal;
  if (options.nativeSignal !== undefined) spec.nativeSignal = options.nativeSignal;
  if (options.pty !== undefined) spec.pty = options.pty;
  return context.process.run(spec);
}

/**
 * Assert one measured result against a `checkScenario`-style expectation and
 * fold it into a `JourneyOutcome`. A timeout is always a failure; otherwise the
 * outcome is `pass` on no failures, else `fail` with `reasonCode`.
 *
 * @param {JourneyExecutorContext} context
 * @param {MeasuredProcessResult} result
 * @param {import('../cli-acceptance-core.mjs').ScenarioExpectation} expect
 * @param {string} reasonCode kebab-case reason for a failure.
 * @param {string} [label] optional short label prefixed on the diagnostic.
 * @returns {JourneyOutcome}
 */
export function assertCommand(context, result, expect, reasonCode, label) {
  const prefix = label === undefined ? '' : `${label}: `;
  if (result.timedOut) {
    return fail('timed-out', [
      context.assert.diagnostic(`${prefix}timed out`),
      context.assert.diagnostic(result.stderrTail),
    ]);
  }
  const failures = context.assert.check(result, expect);
  if (failures.length > 0) {
    return fail(reasonCode, [
      context.assert.diagnostic(`${prefix}${failures.join('; ')}`),
      context.assert.diagnostic(result.stderrTail),
    ]);
  }
  return pass();
}

/**
 * Parse a measured result's captured stdout as JSON.
 *
 * @param {MeasuredProcessResult} result
 * @returns {{ ok: true, value: unknown } | { ok: false, message: string }}
 */
export function readJson(result) {
  try {
    return { ok: true, value: JSON.parse(result.stdoutCapture) };
  } catch (error) {
    return {
      ok: false,
      message: `stdout is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Build a generic executor for a command-only journey from its shared
 * `commandSteps` source. Runs each step in order through the port and asserts it
 * with the injected `assert.check`; the FIRST failing step fails the journey.
 *
 * @param {(params: CommandStepParams) => readonly CommandStepSpec[]} commandStepsFn
 * @returns {(context: JourneyExecutorContext) => Promise<JourneyOutcome>}
 */
export function makeCommandExecutor(commandStepsFn) {
  return async (context) => {
    // Fixture tarballs are read optionally: a command-only journey that needs no
    // fixture (version/help/init/graph/report/sessions) must not be broken by a
    // fixture-packing failure. A journey that DOES use a tarball fails gracefully
    // on the missing argv rather than throwing here and cascading `unavailable`.
    const params = {
      cwd: context.paths.workRoot,
      expectedVersion: context.installed.resolvedVersion ?? '',
      toolPluginTarball: context.fixtures?.toolPluginTarball,
      fitPackTarball: context.fixtures?.fitPackTarball,
    };
    for (const step of commandStepsFn(params)) {
      if (typeof step.setup === 'function') {
        try {
          step.setup({ cwd: params.cwd });
        } catch (error) {
          return fail('command-step-setup-failed', [
            context.assert.diagnostic(
              `${step.name}: setup threw: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ]);
        }
      }
      const runOptions = { args: step.args, cwd: params.cwd };
      if (step.env !== undefined) runOptions.env = step.env;
      if (step.timeout !== undefined) runOptions.timeoutMs = step.timeout;
      const result = await runCli(context, runOptions);
      const failures = context.assert.check(result, step.expect);
      if (failures.length > 0) {
        return fail('command-step-failed', [
          context.assert.diagnostic(`${step.name}: ${failures.join('; ')}`),
          context.assert.diagnostic(result.stderrTail),
        ]);
      }
    }
    return pass();
  };
}
