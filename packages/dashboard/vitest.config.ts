import { defineConfig, mergeConfig } from 'vitest/config';

import { vitestBase } from '../../.config/vitest.base.js';
export default mergeConfig(
  vitestBase,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts'],
      passWithNoTests: true,
      // Integration tests boot jsdom against the generated dashboard HTML
      // (large vendored document). vitest 4 + vite 7's slower jsdom warm
      // pushed two of these past the 5s default. 20s is generous enough
      // to absorb cold-cache jsdom bootstrap without masking real hangs.
      coverage: {
        include: ['src/**'],
        exclude: [
          'src/**/*.test.ts',
          'src/**/__tests__/**',
          'src/index.ts',
          // Vendored third-party Cytoscape UMD bundle (~493KB minified). It is
          // read as TEXT via `node:fs` and inlined into the generated report's
          // <script> block (see code-paths/cytoscape-vendor.ts) — it is never
          // imported or executed in node, so v8 node-coverage reports it 0%.
          // Its ~13.5k statements / ~2.7k functions otherwise swamp the
          // first-party totals (dragging 98%+ first-party coverage down to ~2%).
          // Excluding genuinely-uninstrumentable vendored code is correct; the
          // thresholds below scope to node-instrumentable first-party logic.
          'src/vendor/**',
          // Browser client modules (L4): real, DOM-typed TS bundled by esbuild
          // and executed in jsdom via the eval'd bundle string — never imported
          // or executed in node, so v8 node-coverage reports them 0% (same case
          // as the vendor blob above). They ARE behaviourally covered by the
          // jsdom tests that build fixtures from the bundle; they gain type
          // (src/client/tsconfig.json) + lint checking the prior String.raw
          // emitters never had. Pre-migration the equivalent JS lived inside
          // template-literal strings and was likewise never line-instrumented.
          'src/client/**',
          'src/client-bundle.generated.ts',
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
