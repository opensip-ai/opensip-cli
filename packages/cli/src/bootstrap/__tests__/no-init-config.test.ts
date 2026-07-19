/**
 * no-init synthesis is a thin language-detection wrapper over the shared
 * starter configuration model.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { synthesizeNoInitConfigDocument } from '../no-init-config.js';
import {
  STARTER_GLOBAL_EXCLUDES,
  buildStarterConfigDocument,
  canonicalStarterLanguages,
} from '../starter-config.js';

describe('synthesizeNoInitConfigDocument', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'no-init-config-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined when no language markers are present', () => {
    expect(synthesizeNoInitConfigDocument(dir)).toBeUndefined();
  });

  it('synthesizes the shared starter document for a TypeScript project', () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{}', 'utf8');
    const synthesized = synthesizeNoInitConfigDocument(dir);
    expect(synthesized).toBeDefined();
    expect(synthesized!.languages).toEqual(['typescript']);
    expect(synthesized!.document).toEqual(buildStarterConfigDocument(['typescript']));
    expect(synthesized!.document.globalExcludes).toEqual([...STARTER_GLOBAL_EXCLUDES]);
  });

  it('canonicalizes polyglot markers into ALL_LANGUAGES order', () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{}', 'utf8');
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname="x"\n', 'utf8');
    writeFileSync(join(dir, 'go.mod'), 'module example.com/x\n', 'utf8');
    const synthesized = synthesizeNoInitConfigDocument(dir);
    expect(synthesized).toBeDefined();
    expect(synthesized!.languages).toEqual(
      canonicalStarterLanguages(['typescript', 'python', 'go']),
    );
    expect(synthesized!.document).toEqual(
      buildStarterConfigDocument(['go', 'python', 'typescript']),
    );
  });

  it('does not embed Tool namespaces in the host document', () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}', 'utf8');
    const synthesized = synthesizeNoInitConfigDocument(dir);
    expect(synthesized).toBeDefined();
    expect(synthesized!.document).not.toHaveProperty('fitness');
    expect(synthesized!.document).not.toHaveProperty('graph');
  });
});
