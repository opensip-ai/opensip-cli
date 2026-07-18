import { defineConfig, mergeConfig } from 'vitest/config';

import { vitestBase } from '../../.config/vitest.base.js';
export default mergeConfig(
  vitestBase,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts'],
      coverage: {
        include: ['src/**'],
        exclude: [
          'src/**/*.test.ts',
          'src/**/__tests__/**',
          // Pure type / re-export barrels — no executable code.
          'src/**/index.ts',
          'src/index-*.ts',
          'src/types/index.ts',
          'src/tools/index.ts',
          'src/tools/types.ts',
          'src/plugins/index.ts',
          'src/plugins/types.ts',
          'src/languages/index.ts',
          'src/languages/adapter.ts',
          'src/languages/generic-types.ts',
          'src/languages/workspace-unit.ts',
          // Contract hub modules split from types.ts (M6) — interfaces only.
          'src/tools/cli-context.ts',
          'src/tools/mount-context.ts',
          'src/tools/host-planes.ts',
          'src/tools/scaffold.ts',
          'src/tools/tool-results.ts',
          'src/tools/tool-sessions.ts',
          'src/tools/report-failure.ts',
          'src/tools/manifest-config.ts',
          'src/tools/resource-requirement.ts',
          'src/lib/ui-context.ts',
          'src/lib/run-diagnostics.ts',
          'src/lib/execution/options.ts',
          'src/plugins/capability-discovery-types.ts',
          // Re-export shim — executable code lives in lib/json-guards.ts.
          'src/plugins/json-guards.ts',
          // Progress transport contract — interfaces and type aliases only.
          'src/runtime/progress-transport.ts',
          // Pure interface/type leaves (no runtime exports). Leaving them in
          // the coverage surface pushes statement % just under the 94% CI floor
          // when the type-only modules are imported for typechecking only.
          'src/signals/suppress-types.ts',
          'src/lib/platform-support-types.ts',
        ],
        thresholds: {
          statements: 94,
          branches: 85,
          functions: 95,
          lines: 95,
        },
      },
    },
  }),
);
