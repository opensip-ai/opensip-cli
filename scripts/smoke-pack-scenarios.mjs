/**
 * @fileoverview Command-level scenario set for the packed-artifact smoke test.
 *
 * `scripts/smoke-pack.mjs` installs the freshly-packed tarballs into a throwaway
 * consumer project and then drives the installed bin through these scenarios via
 * the shared, dependency-free CLI acceptance core
 * (`scripts/cli-acceptance-core.mjs`). The scenarios are data — the core is
 * the only thing that spawns and asserts — so the release lane exercises exactly
 * the same scenario semantics as the in-repo Vitest harness.
 *
 * THIS LIST RUNS IN BOTH CI LANES. The PR lane
 * (`packages/cli/src/__tests__/packed-smoke-scenarios-e2e.test.ts`) imports this
 * exact module and drives the BUILT dist CLI through it on every PR, so a
 * `--json`/output-shape change that breaks a scenario fails the PR — not the
 * publish, days later (the pre-2.13 blind spot that blocked 2.12.0 twice). The
 * release lane re-runs it against the PACKED, npm-installed bytes, which is the
 * half only it can do (inter-package export/ABI mismatches). If you change a
 * scenario here, the PR-lane suite is your fast local check:
 * `pnpm --filter=opensip-cli test packed-smoke-scenarios-e2e`.
 *
 * This replaces the old inline `--version`/`--help` pair with a broad
 * command-level walk: init → fit (built-in + fit-pack plugin) → list → graph →
 * dashboard → sessions → tool-plugin install. Every scenario runs in ONE
 * consumer cwd (passed in), in order; later scenarios depend on the side effects
 * (config, plugins, seeded files) of earlier ones.
 *
 * Hermeticity notes:
 *   - The consumer starts empty, so the first real scenario is `init`.
 *   - Plugin installs use `--project` so they land in the consumer's
 *     `opensip-cli/.runtime/plugins/<domain>/` rather than polluting the real
 *     user-global `~/.opensip-cli/`.
 *   - Plugin installs pass an explicit `--domain` because a `.tgz` spec cannot
 *     be marker-sniffed before install (kind-detection reads a directory's
 *     package.json, not inside a tarball), so without `--domain` a tool tarball
 *     would mis-route to the default fit domain.
 *
 * Dependency-free (only imports the acceptance core, which itself only uses
 * node:child_process) so smoke-pack.mjs can import it with no build step.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expectEnvelope } from './cli-acceptance-core.mjs';

/**
 * 2.12.0 (§5.5): `--json` is a `CommandOutcome` wrapper. Non-run command results
 * (init / list / dashboard / plugin / sessions) ride under `.data`; run-command
 * envelopes ride under `.envelope`. These unwrap the inner payload, tolerating a
 * bare shape too (forward/backward robustness — matches `expectEnvelope`).
 */
const cmdData = (parsed) => parsed?.data ?? parsed;
const cmdEnvelope = (parsed) => parsed?.envelope ?? parsed;

/**
 * Build the ordered packed-smoke scenario list.
 *
 * @param {object} opts
 * @param {string} opts.expectedVersion   the consensus release version (no leading 'v')
 * @param {string} opts.consumerCwd       the throwaway consumer project dir (already has the CLI installed)
 * @param {string} opts.toolPluginTarball absolute path to the packed `kind:"tool"` fixture tarball
 * @param {string} opts.fitPackTarball    absolute path to the packed `kind:"fit-pack"` fixture tarball
 * @returns {import('./cli-acceptance-core.mjs').Scenario[]}
 */
export function buildPackedSmokeScenarios({
  expectedVersion,
  consumerCwd,
  toolPluginTarball,
  fitPackTarball,
}) {
  /** @type {import('./cli-acceptance-core.mjs').Scenario[]} */
  const scenarios = [
    {
      name: '--version reports the consensus release version',
      args: ['--version'],
      cwd: consumerCwd,
      expect: {
        exitCode: 0,
        // Substring guard here; smoke-pack.mjs additionally enforces strict
        // `stdout.trim() === expectedVersion` (the packed bytes must report
        // exactly the version we are about to publish).
        stdoutIncludes: expectedVersion,
      },
    },
    {
      name: '--help mounts the full command tree',
      args: ['--help'],
      cwd: consumerCwd,
      expect: {
        exitCode: 0,
        stdoutIncludes: 'Commands:',
      },
    },
    {
      name: '--help lists the fit subcommand',
      args: ['--help'],
      cwd: consumerCwd,
      expect: {
        exitCode: 0,
        stdoutIncludes: 'fit',
      },
    },
    {
      name: 'init --language typescript --json scaffolds a pristine project',
      args: ['init', '--language', 'typescript', '--json'],
      cwd: consumerCwd,
      expect: {
        exitCode: 0,
        json: (parsed) => {
          const failures = [];
          const data = cmdData(parsed);
          if (data?.type !== 'init')
            failures.push(`init.type: expected "init", got ${JSON.stringify(data?.type)}`);
          if (data?.created !== true)
            failures.push(`init.created: expected true, got ${JSON.stringify(data?.created)}`);
          if (typeof data?.path !== 'string' || !data.path.endsWith('opensip-cli.config.yml')) {
            failures.push(
              `init.path: expected a path ending in opensip-cli.config.yml, got ${JSON.stringify(data?.path)}`,
            );
          }
          return failures;
        },
      },
    },
    {
      // Seed the source tree AFTER init (so init sees a pristine project) but
      // BEFORE the built-in fit run. `bad.ts` trips no-console-log; `clean.ts`
      // does not. A tsconfig.json is required by the TS graph adapter and is
      // also seeded here so the later `graph --json` scenario has one.
      name: 'fit --json --check no-console-log flags exactly one finding',
      args: ['fit', '--json', '--check', 'no-console-log'],
      cwd: consumerCwd,
      setup: ({ cwd }) => {
        const root = cwd ?? consumerCwd;
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'src', 'clean.ts'), 'export const x = 1;\n');
        writeFileSync(join(root, 'src', 'bad.ts'), "console.log('debug');\n");
        writeFileSync(
          join(root, 'tsconfig.json'),
          `${JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext' } }, null, 2)}\n`,
        );
      },
      // fit exits 1 when it records error-severity findings (failOnErrors: 1).
      expect: {
        exitCode: 1,
        json: (parsed) => {
          const failures = expectEnvelope({ tool: 'fit' })(parsed);
          const env = cmdEnvelope(parsed);
          const total = env?.verdict?.summary?.total;
          if (total !== 1)
            failures.push(`fit verdict.summary.total: expected 1, got ${JSON.stringify(total)}`);
          const signals = Array.isArray(env?.signals) ? env.signals : [];
          if (!signals.some((s) => s?.source === 'no-console-log')) {
            failures.push('fit signals: expected a no-console-log signal');
          }
          return failures;
        },
      },
    },
    {
      name: 'fit --list --json enumerates the bundled checks',
      args: ['fit', '--list', '--json'],
      cwd: consumerCwd,
      expect: {
        exitCode: 0,
        json: (parsed) => {
          const failures = [];
          const data = cmdData(parsed);
          if (data?.type !== 'list-checks') {
            failures.push(
              `list-checks.type: expected "list-checks", got ${JSON.stringify(data?.type)}`,
            );
          }
          if (typeof data?.totalCount !== 'number' || data.totalCount <= 0) {
            failures.push(
              `list-checks.totalCount: expected > 0, got ${JSON.stringify(data?.totalCount)}`,
            );
          }
          // Guardrail (P1-1): a packed `opensip-cli` install must bundle every
          // language check pack it advertises (README/FAQ/CLAUDE/checks-index all
          // claim TS, Python, Go, Java, C/C++, Rust). The monorepo masks gaps
          // because all packs are root devDeps; only this packed-consumer lane
          // resolves the CLI's *declared* deps alone. Assert one stable slug per
          // pack so a pack dropped from cli/package.json fails the release gate
          // instead of silently shipping a TS-only CLI.
          const slugs = new Set(Array.isArray(data?.checks) ? data.checks.map((c) => c?.slug) : []);
          const requiredByPack = {
            'checks-python': 'python-no-bare-except',
            'checks-go': 'go-no-fmt-print',
            'checks-java': 'java-no-print-stack-trace',
            'checks-cpp': 'cpp-clang-tidy',
            'checks-rust': 'rust-no-dbg-macro',
          };
          for (const [pack, slug] of Object.entries(requiredByPack)) {
            if (!slugs.has(slug)) {
              failures.push(
                `list-checks: expected a "${slug}" check from ${pack} — the packed CLI does not bundle that language pack`,
              );
            }
          }
          return failures;
        },
      },
    },
    {
      name: 'graph --json emits a well-formed graph envelope',
      args: ['graph', '--json'],
      cwd: consumerCwd,
      expect: {
        exitCode: 0,
        json: expectEnvelope({ tool: 'graph' }),
      },
    },
    {
      name: 'dashboard --no-open --json writes the report without launching a browser',
      args: ['dashboard', '--no-open', '--json'],
      cwd: consumerCwd,
      expect: {
        exitCode: 0,
        json: (parsed) => {
          const failures = [];
          const data = cmdData(parsed);
          if (data?.type !== 'dashboard') {
            failures.push(
              `dashboard.type: expected "dashboard", got ${JSON.stringify(data?.type)}`,
            );
          }
          if (data?.opened !== false)
            failures.push(`dashboard.opened: expected false, got ${JSON.stringify(data?.opened)}`);
          return failures;
        },
      },
    },
    {
      name: 'sessions list reads the run history',
      args: ['sessions', 'list'],
      cwd: consumerCwd,
      expect: { exitCode: 0 },
    },
    {
      // Tool-plugin install path: a `kind:"tool"` package contributes a whole
      // subcommand. `--domain tool` is required (tarball can't be sniffed);
      // `--project` keeps it inside the consumer's .runtime (hermetic).
      name: 'plugin add <tool-plugin> --domain tool --project --json',
      args: ['plugin', 'add', toolPluginTarball, '--domain', 'tool', '--project', '--json'],
      cwd: consumerCwd,
      timeout: 120_000,
      expect: {
        exitCode: 0,
        json: (parsed) => {
          const data = cmdData(parsed);
          return data?.success === true
            ? []
            : [
                `plugin-add.success: expected true, got ${JSON.stringify(data?.success)} (${JSON.stringify(data?.error)})`,
              ];
        },
      },
    },
    {
      name: 'audit-demo subcommand contributed by the tool plugin runs',
      args: ['audit-demo'],
      cwd: consumerCwd,
      expect: {
        exitCode: 0,
        stdoutIncludes: 'audit-demo ran',
      },
    },
    {
      // Fit-pack install path: a `kind:"fit-pack"` package contributes checks.
      // `--domain fit` is required (tarball can't be sniffed); `--project`
      // keeps it inside the consumer's .runtime (hermetic).
      name: 'plugin add <fit-pack> --domain fit --project --json',
      args: ['plugin', 'add', fitPackTarball, '--domain', 'fit', '--project', '--json'],
      cwd: consumerCwd,
      timeout: 120_000,
      setup: ({ cwd }) => {
        // Seed a file that trips the fixture check's FIT_PACK_FIXTURE marker.
        const root = cwd ?? consumerCwd;
        writeFileSync(join(root, 'src', 'marker.ts'), 'export const m = "FIT_PACK_FIXTURE";\n');
      },
      expect: {
        exitCode: 0,
        json: (parsed) => {
          const data = cmdData(parsed);
          return data?.success === true
            ? []
            : [
                `plugin-add.success: expected true, got ${JSON.stringify(data?.success)} (${JSON.stringify(data?.error)})`,
              ];
        },
      },
    },
    {
      name: 'fit --json --check <fit-pack-slug> narrows to the contributed check',
      args: ['fit', '--json', '--check', 'fit-pack-fixture-marker'],
      cwd: consumerCwd,
      // fit exits 1 on the error-severity finding the fixture check emits.
      expect: {
        exitCode: 1,
        json: (parsed) => {
          const failures = expectEnvelope({ tool: 'fit' })(parsed);
          const env = cmdEnvelope(parsed);
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
    // ── tools-surface walk (ADR-0041) — depends on the plugin-add scenarios
    //    above (the tool-plugin fixture is installed project-local). ─────────
    {
      name: 'tools list --json shows bundled ids + the installed fixture row',
      args: ['tools', 'list', '--json'],
      cwd: consumerCwd,
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
      name: 'tools validate <tool fixture tarball> passes every section',
      args: ['tools', 'validate', toolPluginTarball, '--json'],
      cwd: consumerCwd,
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
      name: 'tools uninstall removes the project-local fixture',
      args: ['tools', 'uninstall', 'audit-demo-tool', '--project', '--json'],
      cwd: consumerCwd,
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
      name: 'tools list --json no longer shows the fixture row',
      args: ['tools', 'list', '--json'],
      cwd: consumerCwd,
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

  return scenarios;
}
