import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { currentScope, isPathInside } from '@opensip-cli/core';

/**
 * Resolve durable Session/Run cwd evidence to a physical project-contained
 * directory while preserving legitimate nested invocation provenance.
 *
 * Project discovery is the authority boundary. A Tool-supplied cwd that cannot
 * be proven inside that canonical project falls back to the host invocation
 * cwd, then to the canonical project root. Outside project scope, an existing
 * directory is still canonicalized so literal platform aliases do not enter
 * new evidence; historical/missing paths retain their lexical value.
 */
export function authoritativeEvidenceCwd(candidate: string): string {
  const project = currentScope()?.projectContext;
  const canonicalCandidate = canonicalExistingDirectory(candidate);
  if (project === undefined || project.scope === 'none') {
    return canonicalCandidate ?? candidate;
  }
  if (canonicalCandidate !== undefined && isPathInside(canonicalCandidate, project.projectRoot)) {
    return canonicalCandidate;
  }
  const canonicalInvocation = canonicalExistingDirectory(project.cwd);
  if (canonicalInvocation !== undefined && isPathInside(canonicalInvocation, project.projectRoot)) {
    return canonicalInvocation;
  }
  return project.projectRoot;
}

function canonicalExistingDirectory(candidate: string): string | undefined {
  try {
    return realpathSync(resolve(candidate));
  } catch {
    return undefined;
  }
}
