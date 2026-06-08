/**
 * @fileoverview CLI acceptance harness — dependency-free spawn/assert core.
 *
 * One scenario runner that targets an ARBITRARY opensip-tools binary:
 *   - { kind: 'node-script', script: '<abs>/packages/cli/dist/index.js' }  (PR lane)
 *   - { kind: 'installed-bin', bin: '<abs>/node_modules/.bin/opensip-tools' } (release lane)
 *
 * A scenario is data; this module is the only thing that knows how to spawn and
 * assert. The TS Vitest wrapper (packages/cli/src/__tests__/harness/) and the
 * release script (scripts/smoke-pack.mjs) both import this core, so scenario
 * semantics are provably identical in both lanes. Dependency-free (only
 * node:child_process) so the release script can import it with no build step.
 *
 * Types live in the sibling `cli-acceptance-core.d.mts` — the single source of
 * type truth for this module (the repo has `allowJs` off, so TS consumers read
 * the declaration, not JSDoc). Keep this file's comments to prose/rationale;
 * encode types in the `.d.mts`, not in duplicate `@param`/`@returns` tags here.
 */

import { spawnSync } from 'node:child_process'

/**
 * Spawn the CLI once. Never throws on a non-zero exit — returns the captured
 * streams + exit code (mirroring the catch blocks the four legacy helpers used).
 *
 * Uses `spawnSync` (not `execFileSync`) so BOTH streams are captured regardless
 * of exit code: a process that warns on stderr but exits 0 (e.g. an
 * unrecognized-language-tag warning) still surfaces its stderr. `execFileSync`
 * only returns stdout on the success path and would silently drop that stderr.
 */
export function spawnCli(descriptor, args, opts = {}) {
  const file = descriptor.kind === 'node-script' ? 'node' : descriptor.bin
  const argv = descriptor.kind === 'node-script' ? [descriptor.script, ...args] : [...args]
  const result = spawnSync(file, argv, {
    cwd: opts.cwd,
    encoding: 'utf8',
    timeout: opts.timeout ?? 60_000,
    env: { ...process.env, NO_COLOR: '1', ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  }
}

/**
 * Assert a single result against a scenario's `expect` block. Returns the list
 * of failure messages — an empty array means the scenario passed.
 */
export function checkScenario(result, expect = {}) {
  const failures = []

  if (expect.exitCode !== undefined && result.exitCode !== expect.exitCode) {
    failures.push(`exitCode: expected ${expect.exitCode}, got ${result.exitCode}`)
  }
  if (expect.exitCodeOneOf !== undefined && !expect.exitCodeOneOf.includes(result.exitCode)) {
    failures.push(`exitCode: expected one of [${expect.exitCodeOneOf.join(', ')}], got ${result.exitCode}`)
  }
  if (expect.stdoutIncludes !== undefined && !result.stdout.includes(expect.stdoutIncludes)) {
    failures.push(`stdout missing substring: ${JSON.stringify(expect.stdoutIncludes)}`)
  }
  if (expect.stdoutExcludes !== undefined && result.stdout.includes(expect.stdoutExcludes)) {
    failures.push(`stdout unexpectedly contains: ${JSON.stringify(expect.stdoutExcludes)}`)
  }
  if (expect.stderrIncludes !== undefined && !result.stderr.includes(expect.stderrIncludes)) {
    failures.push(`stderr missing substring: ${JSON.stringify(expect.stderrIncludes)}`)
  }
  if (expect.json !== undefined) {
    let parsed
    try {
      parsed = JSON.parse(result.stdout)
    } catch (error) {
      failures.push(`stdout is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      return failures
    }
    failures.push(...expect.json(parsed))
  }
  return failures
}

/**
 * Shape-assert an opensip-tools `--json` Signal envelope. Returns a predicate
 * over the parsed stdout suitable for a scenario's `expect.json`.
 *
 * 2.12.0 (§5.5): `--json` is a `CommandOutcome` wrapper; the (unchanged) signal
 * envelope rides under `.envelope`. This predicate unwraps it (tolerating a bare
 * envelope too, for forward/backward robustness) before shape-asserting.
 */
export function expectEnvelope(opts = {}) {
  return (outcome) => {
    const failures = []
    if (outcome === null || typeof outcome !== 'object') {
      return ['outcome is not an object']
    }
    const parsed = outcome.envelope ?? outcome
    if (parsed.schemaVersion !== 2) {
      failures.push(`envelope.schemaVersion: expected 2, got ${JSON.stringify(parsed.schemaVersion)}`)
    }
    if (opts.tool !== undefined && parsed.tool !== opts.tool) {
      failures.push(`envelope.tool: expected ${JSON.stringify(opts.tool)}, got ${JSON.stringify(parsed.tool)}`)
    }
    if (!Array.isArray(parsed.signals)) {
      failures.push('envelope.signals is not an array')
    }
    return failures
  }
}

/**
 * Run a scenario list against one binary descriptor, in order. Each scenario's
 * optional `setup` hook runs before its spawn; a throwing hook fails just that
 * scenario. Returns pass/fail counts plus the per-scenario results.
 */
export function runScenarios(descriptor, scenarios) {
  const results = []
  for (const scenario of scenarios) {
    if (typeof scenario.setup === 'function') {
      try {
        scenario.setup({ cwd: scenario.cwd, descriptor, scenario })
      } catch (error) {
        results.push({
          name: scenario.name,
          ok: false,
          failures: [`setup threw: ${error instanceof Error ? error.message : String(error)}`],
          result: { stdout: '', stderr: '', exitCode: -1 },
        })
        continue
      }
    }
    const result = spawnCli(descriptor, scenario.args, {
      cwd: scenario.cwd,
      env: scenario.env,
      timeout: scenario.timeout,
    })
    const failures = checkScenario(result, scenario.expect)
    results.push({ name: scenario.name, ok: failures.length === 0, failures, result })
  }
  const passed = results.filter((r) => r.ok).length
  return { passed, failed: results.length - passed, results }
}
