import { defineConfig } from 'vitest/config';
export default defineConfig({
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
        // tested in `plugin-config.test.ts`.
        'src/commands/plugin.ts',
        // Two-line dynamic-import wrapper around `ui/render.tsx`. Excluded
        // alongside its target.
        'src/bootstrap/render.ts',
      ],
    },
  },
});
