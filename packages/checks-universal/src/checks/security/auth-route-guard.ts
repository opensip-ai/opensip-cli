/**
 * @fileoverview Verify auth group routes are protected
 */

import { logger } from '@opensip-tools/core/logger'

import { defineCheck, type CheckViolation } from '@opensip-tools/core'

// Patterns indicating auth protection
const AUTH_PROTECTION_PATTERNS = [
  /useAuth/,
  /useSession/,
  /isAuthenticated/,
  /authState/,
  /requireAuth/,
  /withAuth/,
  /ProtectedRoute/,
  /AuthGuard/,
  /useUser/,
]

/**
 * Check: security/auth-route-guard
 *
 * Verifies that routes in the (auth) group are properly protected
 * by global auth state. Layout files in (auth) directories should
 * include authentication checks.
 */
export const authRouteGuard = defineCheck({
  id: 'e33d59ea-da9d-45c0-bab7-037f737b8560',
  slug: 'auth-route-guard',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description:
    'Verify (auth) group _layout files include authentication checks (useAuth/useSession hooks)',
  longDescription: `**Purpose:** Ensures Expo Router \`(auth)\` group layout files contain an authentication check, so protected routes redirect unauthenticated users.

**Detects:**
- \`_layout\` files inside \`(auth)\` directories that do not reference any auth protection pattern: \`useAuth\`, \`useSession\`, \`isAuthenticated\`, \`authState\`, \`requireAuth\`, \`withAuth\`, \`ProtectedRoute\`, \`AuthGuard\`, or \`useUser\`

**Why it matters:** Without an auth guard in the layout, users can navigate directly to protected screens without being authenticated, bypassing access control.

**Scope:** Codebase-specific convention for Expo Router auth groups. Analyzes each file individually.`,
  tags: ['security', 'authentication', 'routes', 'expo'],
  fileTypes: ['ts', 'tsx'],

  analyze(content: string, filePath: string): CheckViolation[] {
    logger.debug({
      evt: 'fitness.checks.auth_route_guard.analyze',
      msg: 'Analyzing file for auth route guard compliance',
    })
    // Only check auth group layout files
    if (!filePath.includes('(auth)') || !filePath.includes('_layout')) {
      return []
    }

    // Check if file has auth protection
    const hasAuthCheck = AUTH_PROTECTION_PATTERNS.some((pattern) => pattern.test(content))

    if (!hasAuthCheck) {
      return [
        {
          line: 1,
          column: 0,
          message:
            'Auth group layout missing authentication check - add useAuth hook and redirect unauthenticated users',
          severity: 'warning',
          suggestion:
            'Add useAuth() or useSession() hook at the top of the layout component and redirect to login if not authenticated: const { isAuthenticated } = useAuth(); if (!isAuthenticated) return <Redirect href="/login" />;',
          match: '(auth)/_layout',
          filePath,
        },
      ]
    }

    return []
  },
})
