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
        ],
        thresholds: {
          statements: 90,
          functions: 90,
          lines: 90,
          // Branches sit one point below the other three (84 vs 90). The CLI is
          // the composition root: it is dense with defensive arms that are
          // either UNREACHABLE by construction (e.g. RunScope guarantees its
          // datastore slot is always a thunk — `() => undefined` when unset — so
          // the `thunk ? thunk() : undefined` else can never execute) or only
          // reachable via impractical fault injection (30s child-probe timeouts,
          // a crashing Node inspector session, an OTel meter-provider that
          // rejects shutdown). Statements/functions/lines all hold at 93-95%;
          // forcing the branch arm to 90 would mean ignore-annotating provably
          // dead code. 84 reflects the genuinely-reachable branch surface.
          branches: 84,
        },
      },
    },
  }),
);
