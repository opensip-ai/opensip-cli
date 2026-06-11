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
          'src/ui/App.tsx',
          'src/ui/render.tsx',
          // The plugin command shells out to `npm install/uninstall` and
          // edits opensip-tools.config.yml. The dispatch is exercised by
          // `e2e.test.ts > plugin list`; deeper add/remove/sync flows are
          // tested in `plugin-config.test.ts`. `plugin-host-ops.ts` holds the
          // npm/host-mutation helpers extracted out of `plugin.ts` — same
          // unobservable-shell-out rationale, so it is excluded alongside it.
          'src/commands/plugin.ts',
          'src/commands/plugin-host-ops.ts',
          // Two-line dynamic-import wrapper around `ui/render.tsx`. Excluded
          // alongside its target.
          'src/bootstrap/render.ts',
        ],
        thresholds: {
          statements: 90,
          branches: 85,
          functions: 90,
          lines: 90,
        },
      },
    },
  }),
);
