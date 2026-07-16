export interface FixtureFile {
  readonly path: string;
  readonly content: string;
}

/** Two real package identities with reciprocal imports and resolved call edges. */
export const PACKAGE_EVIDENCE_FILES: readonly FixtureFile[] = [
  {
    path: 'packages/a/package.json',
    content: JSON.stringify({
      name: '@fixture/a',
      version: '1.0.0',
      type: 'module',
    }),
  },
  {
    path: 'packages/a/src/index.ts',
    content: [
      "import { fromB } from '../../b/src/index.js';",
      'export function fromA(): number { return fromB(); }',
      '',
    ].join('\n'),
  },
  {
    path: 'packages/b/package.json',
    content: JSON.stringify({
      name: '@fixture/b',
      version: '1.0.0',
      type: 'module',
    }),
  },
  {
    path: 'packages/b/src/index.ts',
    content: [
      "import { fromA } from '../../a/src/index.js';",
      // Bare external builtin: exercises the external-specifier classification
      // path end-to-end (target kept as the specifier, toPackage null).
      "import { sep } from 'node:path';",
      'export function fromB(): number { return sep.length; }',
      'export function cycleB(): number { return fromA(); }',
      '',
    ].join('\n'),
  },
  {
    path: 'packages/a/src/twin.ts',
    content: [
      "import { fromA } from './index.js';",
      'function target(): number { return fromA(); }',
      'export function sharedTwin(): number { return target(); }',
      '',
    ].join('\n'),
  },
  {
    path: 'packages/b/src/twin.test.ts',
    content: [
      "import { fromB } from './index.js';",
      'function target(): number { return fromB(); }',
      'export function sharedTwin(): number { return target(); }',
      '',
    ].join('\n'),
  },
] as const;
