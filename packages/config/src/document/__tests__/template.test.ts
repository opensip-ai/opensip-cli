/**
 * Coverage for the init scaffold skeleton renderer (2.10.1, ADR-0023, Phase 3).
 * config owns the document-shape rendering; this asserts the output is the
 * expected YAML AND that it parses clean through the host declarations (no
 * drift between the template and the schema that validates it).
 */

import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { composeConfigSchema, validateConfigDocument } from '../../composer.js';
import { hostConfigDeclarations } from '../host-declarations.js';
import { renderDocumentHeader, type TargetTemplateInput } from '../template.js';

const TS_TARGET: TargetTemplateInput = {
  name: 'typescript-source',
  description: 'TypeScript / TSX source code',
  languages: ['typescript'],
  include: ['src/**/*.ts'],
  exclude: ['**/*.test.ts'],
};

describe('renderDocumentHeader', () => {
  it('renders schemaVersion, globalExcludes, and the targets block', () => {
    const out = renderDocumentHeader({ schemaVersion: 1, targets: [TS_TARGET] });
    expect(out).toContain('schemaVersion: 1');
    expect(out).toContain('globalExcludes:');
    expect(out).toContain('  typescript-source:');
    expect(out).toContain('    description: TypeScript / TSX source code');
    expect(out).toContain('    languages: [typescript]');
    expect(out).toContain('    concerns: [backend]'); // default concern
    expect(out).toContain('      - "src/**/*.ts"');
  });

  it('honours an explicit globalExcludes + concerns override', () => {
    const out = renderDocumentHeader({
      schemaVersion: 2,
      globalExcludes: ['custom/**'],
      targets: [{ ...TS_TARGET, concerns: ['backend', 'api'] }],
    });
    expect(out).toContain('schemaVersion: 2');
    expect(out).toContain('  - "custom/**"');
    expect(out).toContain('    concerns: [backend, api]');
  });

  it('produces a document the host declarations accept (no drift)', () => {
    const out = renderDocumentHeader({ schemaVersion: 1, targets: [TS_TARGET] });
    const parsed = parseYaml(out);
    const schema = composeConfigSchema(hostConfigDeclarations());
    expect(() => validateConfigDocument(schema, parsed)).not.toThrow();
  });
});
