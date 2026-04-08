/**
 * @fileoverview Client Boundary Placement Check
 *
 * Warns when 'use client' directive is placed at page/layout level in Next.js app directory.
 * Pages, layouts, and templates should remain Server Components for better performance.
 */

import * as path from 'node:path'

import { defineCheck, type CheckViolation } from '@opensip-tools/core'

/**
 * Files in app/ directory that should remain Server Components
 */
const SERVER_COMPONENT_FILES = ['page.tsx', 'layout.tsx', 'template.tsx']

/**
 * Pattern to match 'use client' directive at the start of a file
 * Allows for leading comments (single-line or multi-line) before the directive
 */
// eslint-disable-next-line sonarjs/slow-regex -- matches leading comments before 'use client' directive; bounded by file start
const USE_CLIENT_PATTERN = /^(?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*\n)*\s*['"]use client['"]/

/**
 * Check if a file is in an app/ directory (Next.js app router)
 */
function isAppDirectoryFile(filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/')
  return normalizedPath.includes('/app/')
}

/**
 * Check if file is a page, layout, or template file
 */
function isServerComponentFile(filePath: string): boolean {
  const fileName = path.basename(filePath)
  return SERVER_COMPONENT_FILES.includes(fileName)
}

/**
 * Check if file content has 'use client' directive
 */
function hasUseClientDirective(content: string): boolean {
  return USE_CLIENT_PATTERN.test(content)
}

/**
 * Get line number of 'use client' directive
 */
function getUseClientLine(content: string): number {
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const lineContent = lines[i]
    if (lineContent === undefined) {
      continue
    }
    const line = lineContent.trim()
    if (line === "'use client'" || line === '"use client"') {
      return i + 1
    }
  }
  return 1
}

/**
 * Analyze a file for client boundary placement issues
 */
function analyzeFile(content: string, filePath: string): CheckViolation[] {
  // Only check TSX files
  if (!filePath.endsWith('.tsx')) {
    return []
  }

  if (!isAppDirectoryFile(filePath)) {
    return []
  }

  if (!isServerComponentFile(filePath)) {
    return []
  }

  // Quick filter: skip files without 'use client'
  if (!content.includes('use client')) {
    return []
  }

  if (!hasUseClientDirective(content)) {
    return []
  }

  const line = getUseClientLine(content)
  const fileName = path.basename(filePath)

  return [
    {
      filePath,
      line,
      column: 1,
      message: `'use client' directive in ${fileName} converts entire page/layout to Client Component`,
      severity: 'warning',
      type: 'client-boundary',
      suggestion:
        "Move 'use client' to child components. Keep pages/layouts as Server Components for better performance.",
      match: 'use client',
    },
  ]
}

/**
 * Check: quality/frontend/client-boundary-placement
 *
 * Warns when 'use client' directive is placed at page/layout level in Next.js app directory.
 * Pages, layouts, and templates should remain Server Components for optimal performance.
 */
export const clientBoundaryPlacement = defineCheck({
  // @fitness-ignore-next-line fitness-check-standards -- Subcategory ID format (quality/frontend/name) is intentional for frontend-specific checks
  id: '13ff0b54-9411-4713-9d42-69f4b189f665',
  slug: 'frontend-client-boundary-placement',
  disabled: true,
  scope: { languages: ['typescript', 'tsx'], concerns: ['frontend', 'ui'] },
  contentFilter: 'code-only',

  confidence: 'medium',
  description:
    "Warn when 'use client' directive is placed at page/layout level in Next.js app directory",
  longDescription: `**Purpose:** Prevents \`'use client'\` directives from being placed in Next.js App Router page-level files, which would convert entire pages into Client Components.

**Detects:** Analyzes each file individually using regex and path-based checks.
- Files named \`page.tsx\`, \`layout.tsx\`, or \`template.tsx\` inside an \`/app/\` directory that start with \`'use client'\` or \`"use client"\` (allowing leading comments)
- Only scans \`.tsx\` files; excludes test files

**Why it matters:** Converting pages/layouts to Client Components loses Server Component benefits like streaming, reduced JS bundle size, and server-side data fetching.

**Scope:** General best practice`,
  tags: ['quality', 'performance', 'next-js', 'react'],
  fileTypes: ['ts', 'tsx'],

  analyze: analyzeFile,
})
