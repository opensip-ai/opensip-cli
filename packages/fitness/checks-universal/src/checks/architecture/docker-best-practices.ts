// @fitness-ignore-file fitness-check-standards -- Dockerfile check scans non-standard file types that do not map to a fileTypes extension array
/**
 * @fileoverview Docker best practices fitness check
 * @invariants
 * - Security rules (non-root user, no secrets, production-dependencies) are errors (blocking)
 * - Efficiency rules (layer ordering, multi-stage, no-build-tools-in-runner) are warnings (advisory)
 * - All Dockerfiles in the repository are scanned
 */

import * as path from 'node:path';

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

import { analyzeDockerfile } from './docker-best-practices-analyze.js';

/**
 * Check: architecture/docker-best-practices
 *
 * Validates Dockerfiles follow security and efficiency best practices:
 * - Multi-stage builds
 * - Non-root user
 * - No hardcoded secrets
 * - Frozen lockfiles for package managers
 * - HEALTHCHECK instruction
 * - Proper COPY order for layer caching
 * - Production-only dependencies in runtime image (no devDependencies)
 * - No build tools (pnpm, corepack) inherited in runtime stage
 * - BuildKit cache mounts for package install commands
 */
export const dockerBestPractices = defineCheck({
  id: '9870251d-6d3c-49b7-a680-864bc892b19e',
  slug: 'docker-best-practices',
  disabled: true,
  scope: { languages: ['json', 'typescript', 'yaml'], concerns: ['config'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Validate Dockerfiles follow security and efficiency best practices',
  longDescription: `**Purpose:** Enforces security and efficiency best practices in Dockerfiles across the repository.

**Detects:**
- Hardcoded secrets (API keys, AWS credentials, passwords, JWT secrets, private keys)
- Missing multi-stage builds, missing non-root \`USER\` directive, missing \`HEALTHCHECK\`
- Package installs without \`--frozen-lockfile\` (pnpm/npm/yarn)
- \`COPY .\` before dependency file copy (poor layer caching)
- Missing BuildKit cache mounts on package installs
- Runtime stage inheriting from build stage or copying \`node_modules\` without \`--prod\`

**Why it matters:** Prevents security vulnerabilities (running as root, leaked secrets), non-reproducible builds, and bloated production images.

**Scope:** General best practice. Analyzes each file individually.`,
  tags: ['docker', 'security', 'best-practices', 'architecture'],

  analyze(content: string, filePath: string): CheckViolation[] {
    const file = path.relative(process.cwd(), filePath);
    const violations = analyzeDockerfile(content, filePath, file);

    return violations.map((violation) => ({
      line: violation.line,
      message: violation.message + (violation.suggestion ? ` (${violation.suggestion})` : ''),
      severity: violation.severity,
      suggestion: violation.suggestion ?? 'See Docker best practices documentation.',
      match: violation.rule,
      type: violation.rule,
    }));
  },
});