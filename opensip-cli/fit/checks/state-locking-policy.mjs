/**
 * ADR-0075: datastore write paths use withWriteLock; file-lock primitive exists.
 */
import { defineCheck } from '@opensip-cli/fitness';

const DATASTORE_PATH = /packages\/datastore\/src\/data-store\.ts$/;
// The session write path (save/upsert) lives in the write repo after the
// SessionRepo read/write/maintenance split (P1-F4); the facade only delegates.
const SESSION_PATH = /packages\/session-store\/src\/session-write-repo\.ts$/;
const FILE_LOCK_PATH = /packages\/core\/src\/lib\/file-lock\.ts$/;

export function analyzeStateLockingPolicy(content, filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  const violations = [];

  if (DATASTORE_PATH.test(normalized) && !content.includes('withWriteLock')) {
    violations.push({
      message: 'DataStore missing withWriteLock seam',
      severity: 'error',
    });
  }

  if (SESSION_PATH.test(normalized) && !content.includes("withWriteLock('session.save'")) {
    violations.push({
      message: 'SessionWriteRepo.save missing withWriteLock',
      severity: 'error',
    });
  }

  if (FILE_LOCK_PATH.test(normalized) && !content.includes('withFileLock')) {
    violations.push({
      message: 'core file-lock helper missing',
      severity: 'error',
    });
  }

  return violations;
}

export const checks = [
  defineCheck({
    id: 'c8d1e2f3-4a5b-6c7d-8e9f-0a1b2c3d4e5f',
    slug: 'state-locking-policy',
    description: 'Datastore exposes withWriteLock and repositories call it on writes (ADR-0075).',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'state'],
    fileTypes: ['ts'],
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeStateLockingPolicy(content, filePath),
  }),
];
