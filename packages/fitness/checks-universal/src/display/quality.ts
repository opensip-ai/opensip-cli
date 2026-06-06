/**
 * @fileoverview Display entries for cross-language quality checks
 */

import type { CheckDisplayEntry } from './types.js'

/** Quality check display entries (UNIVERSAL only, sorted alphabetically by slug) */
export const QUALITY_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  'async-state-pattern': ['⏳', 'Async State Pattern'],
  'dead-code': ['☠️', 'Dead Code'],
  'dependency-version-consistency': ['📦', 'Dependency Version Consistency'],
  'eslint-justifications': ['🔍', 'ESLint Justifications'],
  'expo-vector-icons': ['📱', 'Expo Vector Icons'],
  'fitness-ignore-hygiene': ['🧹', 'Fitness Ignore Hygiene'],
  'graph-ignore-hygiene': ['🧹', 'Graph Ignore Hygiene'],
  'graphql-offset-pagination': ['🔌', 'GraphQL Offset Pagination'],
  'image-optimization': ['🖼️', 'Image Optimization'],
  'navigation-typing': ['📱', 'Navigation Typing'],
  'no-ai-attribution': ['🤖', 'No AI Attribution'],
  'no-compatibility-layer-names': ['🧹', 'No Compatibility Layer Names'],
  'no-console-log': ['🚫', 'No Console Log'],
  'no-deprecated-tags': ['🧹', 'No Deprecated Tags'],
  'no-markdown-references': ['📝', 'No Markdown References'],
  'no-non-null-assertions': ['🛡️', 'No Non-Null Assertions'],
  'no-process-artifacts': ['🗓️', 'No Process Artifacts'],
  'no-raw-regex-on-code': ['🔍', 'No Raw Regex On Code'],
  'no-temporary-workarounds': ['🧹', 'No Temporary Workarounds'],
  'no-todo-comments': ['📝', 'No TODO Comments'],
  'no-unimplemented-markers': ['🚧', 'No Unimplemented Markers'],
  'no-window-alert': ['🚫', 'No Window Alert'],
  'performance-anti-patterns': ['⚡', 'Performance Anti-Patterns'],
  'pino-serializer-coverage': ['📊', 'Pino Serializer Coverage'],
  'semgrep-justifications': ['🔍', 'Semgrep Justifications'],
  'typescript-directive-hygiene': ['📘', 'TypeScript Directive Hygiene'],
  'zod-openapi-sync': ['🔌', 'Zod OpenAPI Sync'],
})
