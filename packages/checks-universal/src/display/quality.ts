/**
 * @fileoverview Display entries for cross-language quality checks
 */

import type { CheckDisplayEntry } from './types.js'

/** Quality check display entries (UNIVERSAL only, sorted alphabetically by slug) */
export const QUALITY_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  'async-state-pattern': ['⏳', 'Async State Pattern'],
  'comment-quality': ['💬', 'Comment Quality'],
  'dead-code': ['☠️', 'Dead Code'],
  'dependency-security-audit': ['🔒', 'Dependency Security Audit'],
  'dependency-version-consistency': ['📦', 'Dependency Version Consistency'],
  'eslint-justifications': ['🔍', 'ESLint Justifications'],
  'expo-vector-icons': ['📱', 'Expo Vector Icons'],
  'fitness-ignore-hygiene': ['🧹', 'Fitness Ignore Hygiene'],
  'graphql-offset-pagination': ['🔌', 'GraphQL Offset Pagination'],
  'image-optimization': ['🖼️', 'Image Optimization'],
  'navigation-typing': ['📱', 'Navigation Typing'],
  'no-console-log': ['🚫', 'No Console Log'],
  'no-legacy-code': ['🧹', 'No Legacy Code'],
  'no-markdown-references': ['📝', 'No Markdown References'],
  'no-non-null-assertions': ['🛡️', 'No Non-Null Assertions'],
  'no-raw-regex-on-code': ['🔍', 'No Raw Regex On Code'],
  'no-window-alert': ['🚫', 'No Window Alert'],
  'performance-anti-patterns': ['⚡', 'Performance Anti-Patterns'],
  'pino-serializer-coverage': ['📊', 'Pino Serializer Coverage'],
  'security-scan-suite': ['🔒', 'Security Scan Suite'],
  'semgrep-justifications': ['🔍', 'Semgrep Justifications'],
  'todo-comments': ['📝', 'TODO Comments'],
  'typescript-directive-hygiene': ['📘', 'TypeScript Directive Hygiene'],
  'zod-openapi-sync': ['🔌', 'Zod OpenAPI Sync'],
})
