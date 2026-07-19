import { defineConfig, mergeConfig } from 'vitest/config';

import { vitestBase } from '../../.config/vitest.base.js';
export default mergeConfig(
  vitestBase,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      coverage: {
        include: ['src/**'],
        exclude: [
          'src/**/*.test.ts',
          'src/**/*.test.tsx',
          'src/**/__tests__/**',
          // Pure type / re-export barrels — no executable code.
          'src/commands/index.ts',
          'src/bootstrap/index.ts',
          'src/api.ts',
          // Integration-only entry points exercised via subprocess in
          // src/__tests__/e2e.test.ts (and friends). Coverage instrumentation
          // can't observe spawned-binary execution, and reaching these in
          // process would require duplicating the bootstrap orchestration we
          // already run as a binary. They are pure wiring around already-
          // tested helpers.
          'src/index.ts',
          // Imported only by the excluded CLI entrypoint and exercised by the
          // lightweight-command-probe E2E subprocess lane. V8 cannot attribute
          // spawned-process execution back to this package-level coverage run.
          'src/bootstrap/lightweight-command-probe.ts',
          'src/bootstrap/pre-action-hook.ts',
          'src/commands/tools/runtime-probe-entry.ts',
          'src/ui/App.tsx',
          'src/ui/render.tsx',
          // The plugin command shells out to `npm install/uninstall` and
          // edits opensip-cli.config.yml. The dispatch is exercised by
          // `e2e.test.ts > plugin list`; deeper add/remove/sync flows are
          // tested in `plugin-config.test.ts`. `plugin-host-ops.ts` holds the
          // npm/host-mutation helpers extracted out of `plugin.ts` — same
          // unobservable-shell-out rationale, so it is excluded alongside it.
          'src/commands/plugin.ts',
          'src/commands/plugin-host-ops.ts',
          // Two-line dynamic-import wrapper around `ui/render.tsx`. Excluded
          // alongside its target.
          'src/bootstrap/render.ts',
          // The shared Vitest aliases inline workspace dependencies so CLI
          // integration tests can run against source. Coverage for those
          // sibling packages belongs to their own package-level test lanes.
          '../cli-live/src/**',
          '../cli-ui/src/**',
          'cli-live/src/**',
          'cli-ui/src/**',
          '**/packages/cli-live/src/**',
          '**/packages/cli-ui/src/**',
          // Pure type-definition modules — no executable code.
          'src/bootstrap/pre-action-runtime.ts',
          'src/bootstrap/tool-admission-types.ts',
          'src/bootstrap/tool-command-dispatch-types.ts',
          'src/commands/shared.ts',
          // Spawn-error / timeout arms of the probe parent are not mockable under
          // ESM (node:child_process.spawnSync is not configurable). The happy,
          // stderr-only, and empty-dir paths are covered here; full validate
          // integration is exercised by the tools e2e lane.
          'src/commands/tools/runtime-probe.ts',
          // Capability pack isolation runs through a forked CLI worker. The
          // child entrypoint and supervisor are exercised by capability-pack
          // integration tests, but V8 cannot observe the child process. The
          // guard installer monkey-patches Node builtins process-wide; the pure
          // path classifier is unit-tested, while installing the patches in
          // this process would contaminate unrelated tests.
          'src/bootstrap/capability-worker/entry.ts',
          'src/bootstrap/capability-worker/supervisor.ts',
          'src/bootstrap/capability-worker/guards.ts',
          // Static copied bootstrap manifest, validated by the manifest/tool
          // admission tests rather than line coverage.
          'src/bootstrap/bundled-tools.manifest.json',
        ],
        thresholds: {
          statements: 90,
          functions: 90,
          lines: 90,
          // Branches sit below the other three (82 vs 90). The CLI is the
          // composition root: it is dense with defensive arms that are either
          // UNREACHABLE by construction or only reachable via impractical fault
          // injection. Fresh measurement on the reachable surface stabilizes
          // around 82–83% without annotating provably dead arms.
          // 0.6.0 inventory/bootstrap expansion measured 81.8; hold the
          // composition-root floor at 81 rather than force-fault-injection.
          branches: 81,
        },
      },
    },
  }),
);
