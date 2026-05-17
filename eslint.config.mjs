// @ts-check
/**
 * ESLint flat config for the opensip-tools workspace.
 *
 * Layered: shared base for every TS package, plus package-type overrides
 * for tests, React/Ink components, and the simulation kinds (which use
 * intentionally short, non-camelCase identifiers).
 *
 * Plugins:
 *   - typescript-eslint        — type-aware TypeScript rules
 *   - eslint-plugin-sonarjs    — bug detection + complexity + duplication
 *   - eslint-plugin-unicorn    — modern-JS idioms (selectively enabled)
 *   - eslint-plugin-import     — import-order + circular-dep guard
 *
 * Tuning notes:
 *   - sonarjs's cognitive-complexity left at default 15. The CLI's
 *     fit-command flow exceeds it; we add a per-file disable there
 *     rather than weaken the workspace setting.
 *   - unicorn's prevent-abbreviations is OFF — too many domain
 *     abbreviations (cwd, ctx, opts) we don't want to expand.
 *   - unicorn's no-null is OFF — the codebase mixes null/undefined
 *     intentionally for serialized boundaries (JSON, schemas).
 *   - import/no-unresolved uses TypeScript resolver via the .ts
 *     extension list; node_modules are resolved by tsconfig moduleResolution.
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';

export default tseslint.config(
  // ---------------------------------------------------------------------------
  // Global ignores — every package's build output, every node_modules, and
  // anything not source.
  // ---------------------------------------------------------------------------
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      'verdaccio-storage/**',
      'tarballs/**',
      'fixtures/**',
      '**/__fixtures__/**',
      'docs/**',
    ],
  },

  // ---------------------------------------------------------------------------
  // Base — every TS file in the workspace.
  // ---------------------------------------------------------------------------
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  sonarjs.configs.recommended,
  unicorn.configs['flat/recommended'],

  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      import: importPlugin,
    },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parserOptions: {
        // projectService picks each file's owning tsconfig automatically —
        // keeps the workspace's per-package tsconfigs as the source of truth
        // for type-aware rules without an explicit project list.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: ['packages/*/tsconfig.json', 'packages/*/*/tsconfig.json'],
          // The workspace's per-package tsconfigs are intentional (see
          // CLAUDE.md layering); we're not consolidating into project
          // references. Silence the resolver's nag-on-startup.
          noWarnOnMultipleProjects: true,
        },
      },
    },
    rules: {
      // -- TypeScript fine-tuning -----------------------------------------
      // The codebase uses `_unused` arg conventions and intentional `void`
      // expressions for fire-and-forget promises.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      // We accept `any` in tightly-scoped places (third-party JSON parsing,
      // Commander's loose option types). Prefer unknown but don't fail on any.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Allow `Record<string, unknown>` over the more pedantic `object`.
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      // Type-only imports — required for ESM-with-`type: module`.
      '@typescript-eslint/consistent-type-imports': ['error', {
        prefer: 'type-imports',
        fixStyle: 'inline-type-imports',
      }],

      // -- unicorn opinions we override -----------------------------------
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/no-null': 'off',
      'unicorn/filename-case': ['error', { cases: { kebabCase: true } }],
      'unicorn/no-array-callback-reference': 'off',
      // Allow process.exit() — used at CLI boundaries.
      'unicorn/no-process-exit': 'off',
      // Allow nested ternaries in formatters (tableRow.status, etc.).
      'unicorn/no-nested-ternary': 'off',
      // Switch-case keep-readable: don't force every if/else into switch.
      'unicorn/prefer-switch': 'off',
      // The codebase intentionally uses `for...of`/`forEach` interchangeably.
      'unicorn/no-array-for-each': 'off',
      'unicorn/no-array-reduce': 'off',
      // import-style is a stylistic preference; the codebase intentionally
      // mixes `import { x } from 'node:path'` and `import * as path` for
      // good reasons (ESM/CJS bridges, namespace usage).
      'unicorn/import-style': 'off',
      // toSorted() requires Node 20+. We're on 22, but the rule's
      // auto-fix ignores some call sites (sort + spread, sort in-place
      // intent), producing churn for marginal gain. Off for now.
      'unicorn/no-array-sort': 'off',

      // -- sonarjs opinions we soften -------------------------------------
      // Cognitive complexity stays at 15; opt-out files use a per-file
      // disable comment with rationale.
      // The check-pack files often have repeated string literals (slugs,
      // event names) that don't belong in constants.
      'sonarjs/no-duplicate-string': ['warn', { threshold: 5 }],
      // TODO/FIXME tags are tracked by fitness's own `todo-comments`
      // check (in @opensip-tools/checks-universal). Avoid double-flagging.
      'sonarjs/todo-tag': 'off',
      // Math.random is fine for non-security uses (jitter, sample IDs,
      // demo data). Crypto code uses node:crypto explicitly.
      'sonarjs/pseudo-random': 'off',
      // CLI tooling intentionally invokes PATH-resolved binaries
      // (`open`, `xdg-open`, etc.). The risk pattern this rule guards
      // against is server-side command injection, not CLI helpers.
      'sonarjs/no-os-command-from-path': 'off',
      // Locale-aware sort is fine; an explicit comparator is required
      // only when sorting non-strings, which the type checker enforces.
      'sonarjs/no-alphabetical-sort': 'off',
      // `field?: T | undefined` is a deliberate readability choice.
      // Cosmetic; not worth churn.
      'sonarjs/no-redundant-optional': 'off',
      // void on a fire-and-forget promise expression is the documented
      // pattern. The `no-floating-promises` rule already enforces it.
      'sonarjs/void-use': 'off',
      // Comparing a value to `undefined` after `typeof` checks is a
      // type-narrowing idiom; the type checker validates it. Disabled
      // to avoid flagging the pattern.
      'sonarjs/different-types-comparison': 'off',

      // -- import hygiene -------------------------------------------------
      'import/no-cycle': ['error', { maxDepth: 10 }],
      'import/order': ['error', {
        'groups': ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
        'newlines-between': 'always',
        'alphabetize': { order: 'asc', caseInsensitive: true },
      }],
      'import/no-duplicates': 'error',
      // Default to off — the typescript resolver can't always see workspace
      // package mains before they're built. Type checker catches missing
      // imports for type-checked code anyway.
      'import/no-unresolved': 'off',
    },
  },

  // ---------------------------------------------------------------------------
  // Tests — vitest globals, looser rules.
  // ---------------------------------------------------------------------------
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**/*.ts', '**/__tests__/**/*.tsx'],
    rules: {
      'sonarjs/no-duplicate-string': 'off',
      'sonarjs/cognitive-complexity': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      'unicorn/no-useless-undefined': 'off',
    },
  },

  // ---------------------------------------------------------------------------
  // CLI's React/Ink components — JSX, hooks, looser naming.
  // ---------------------------------------------------------------------------
  {
    files: ['packages/cli/src/ui/**/*.{ts,tsx}'],
    rules: {
      // React component filenames are PascalCase.
      'unicorn/filename-case': ['error', {
        cases: { kebabCase: true, pascalCase: true },
      }],
    },
  },

  // ---------------------------------------------------------------------------
  // Simulation kinds — domain-specific names (chaos-events, fix-evaluation)
  // sometimes break unicorn's filename-case rule with mixed scope.
  // ---------------------------------------------------------------------------
  {
    files: ['packages/simulation/**/*.{ts,tsx}'],
    rules: {
      'unicorn/filename-case': 'off',
    },
  },

  // ---------------------------------------------------------------------------
  // Dist files (some intermediate scripts emit JS during builds).
  // ---------------------------------------------------------------------------
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
);
