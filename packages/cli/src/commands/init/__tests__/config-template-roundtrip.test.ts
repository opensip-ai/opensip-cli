/**
 * No-drift guarantee for the `init` scaffold (2.10.1, ADR-0023, Phase 3).
 *
 * The document-level skeleton is rendered by `@opensip-tools/config`
 * (`renderDocumentHeader`) — the same package that composes + STRICT-validates
 * the whole document. This test closes the loop: the config `init` actually
 * writes, for every supported language, must parse clean through the REAL
 * composed schema (host declarations + the first-party tools' declarations).
 * If a future edit makes the template emit a key the schema rejects, this fails.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ToolRegistry } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BUNDLED_TOOLS } from '../../../__tests__/test-utils/bundled-tools.js';
import { composeAndValidateToolConfig } from '../../../bootstrap/config-and-capabilities.js';
import { generateConfig } from '../config-templates.js';

import type { SupportedLanguage } from '../language-detection.js';

const LANGUAGES: readonly SupportedLanguage[] = ['typescript', 'rust', 'python', 'go', 'java', 'cpp'];

function realRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const tool of BUNDLED_TOOLS) reg.register(tool);
  return reg;
}

describe('init config template round-trips through the composed schema', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tmpl-roundtrip-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  for (const lang of LANGUAGES) {
    it(`the ${lang} scaffold validates STRICT (no drift)`, () => {
      const configPath = join(dir, 'opensip-tools.config.yml');
      writeFileSync(configPath, generateConfig([lang]), 'utf8');
      expect(() =>
        composeAndValidateToolConfig({ tools: realRegistry(), configPath, env: {} }),
      ).not.toThrow();
    });
  }

  it('the polyglot (all-languages) scaffold validates STRICT', () => {
    const configPath = join(dir, 'opensip-tools.config.yml');
    writeFileSync(configPath, generateConfig(LANGUAGES), 'utf8');
    expect(() =>
      composeAndValidateToolConfig({ tools: realRegistry(), configPath, env: {} }),
    ).not.toThrow();
  });
});
