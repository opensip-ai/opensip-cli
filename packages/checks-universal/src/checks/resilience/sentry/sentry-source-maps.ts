/**
 * @fileoverview Detect missing Sentry source map upload in bundler configs
 * @module checks-builtin/checks/resilience/sentry/sentry-source-maps
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/core'

import { hasSentryUsage } from './sentry-helpers.js'

// Sentry bundler plugins that handle source map upload
const SOURCE_MAP_PLUGINS = [
  '@sentry/webpack-plugin',
  '@sentry/vite-plugin',
  '@sentry/esbuild-plugin',
  '@sentry/rollup-plugin',
  '@sentry/nextjs',
  '@sentry/nuxt',
  '@sentry/astro',
  'sentryWebpackPlugin',
  'sentryVitePlugin',
  'sentryEsbuildPlugin',
  'sentryRollupPlugin',
]

// File name patterns that indicate a bundler config
const BUNDLER_CONFIG_PATTERNS = [
  'webpack.config',
  'vite.config',
  'rollup.config',
  'esbuild.config',
  'next.config',
  'nuxt.config',
  'astro.config',
]

function isBundlerConfig(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return BUNDLER_CONFIG_PATTERNS.some((pattern) => lower.includes(pattern))
}

function analyze(content: string, filePath: string): CheckViolation[] {
  // Only check bundler config files
  if (!isBundlerConfig(filePath)) return []

  // Only relevant if the project uses Sentry (SDK import in this file or
  // Sentry plugin reference)
  if (!hasSentryUsage(content) && !content.includes('sentry')) return []

  // Check if any Sentry source map plugin is configured
  const hasSourceMapPlugin = SOURCE_MAP_PLUGINS.some((plugin) => content.includes(plugin))
  if (hasSourceMapPlugin) return []

  // The file mentions Sentry but has no source map plugin
  return [
    {
      line: 1,
      message:
        'Bundler config references Sentry but no source map upload plugin is configured — stack traces will be unreadable',
      severity: 'warning',
      suggestion:
        'Add a Sentry source map plugin: npm install @sentry/vite-plugin (or @sentry/webpack-plugin) and add it to your plugins array. This uploads source maps at build time so Sentry can show readable stack traces.',
      type: 'sentry-missing-source-maps',
      filePath,
    },
  ]
}

/**
 * Check: sentry-source-maps
 *
 * Detects bundler configs that reference Sentry but don't include
 * a source map upload plugin.
 */
export const sentrySourceMaps = defineCheck({
  id: 'e5a1c7d4-8f6b-4c2e-d345-b7a9e1f3c6d8',
  slug: 'sentry-source-maps',
  scope: { languages: ['typescript', 'javascript'], concerns: ['backend', 'frontend'] },
  description: 'Detects missing Sentry source map upload — stack traces will be unreadable',
  longDescription: `**Purpose:** Ensures bundler configurations include a Sentry source map upload plugin so production stack traces are readable.

**Detects:**
- Webpack, Vite, Rollup, esbuild, Next.js, Nuxt, or Astro config files that reference Sentry but don't include a Sentry source map plugin (@sentry/webpack-plugin, @sentry/vite-plugin, etc.)

**Why it matters:** Without source maps, Sentry shows minified stack traces (single-character variable names, collapsed files). Developers can't identify the actual source of errors, making Sentry significantly less useful. The Sentry SDK alone doesn't upload source maps — a bundler plugin is required.

**Scope:** Bundler configuration files only (webpack.config.*, vite.config.*, next.config.*, etc.). Analyzes each file individually.`,
  tags: ['sentry', 'quality', 'observability', 'build'],
  fileTypes: ['ts', 'js', 'mjs', 'cjs'],
  confidence: 'high',
  analyze,
})
