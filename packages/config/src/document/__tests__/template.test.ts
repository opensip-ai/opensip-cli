/**
 * Coverage for the init scaffold skeleton renderer (2.10.1, ADR-0023, Phase 3).
 * config owns the document-shape rendering; this asserts the output is the
 * expected YAML AND that it parses clean through the host declarations (no
 * drift between the template and the schema that validates it).
 *
 * Product starter excludes live in the CLI composition root; this package keeps
 * only a small library default when callers omit `globalExcludes`.
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

/** Library fallback only — not the product starter list (CLI-owned). */
const LIBRARY_DEFAULT_EXCLUDES = ['**/node_modules/**', '**/dist/**'] as const;

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

  it('uses the small library default excludes when the caller omits them', () => {
    const out = renderDocumentHeader({ schemaVersion: 1, targets: [TS_TARGET] });
    const parsed = parseYaml(out) as { globalExcludes: string[] };
    expect(parsed.globalExcludes).toEqual([...LIBRARY_DEFAULT_EXCLUDES]);
    // Product starter has eleven entries; the library default stays two.
    expect(parsed.globalExcludes).toHaveLength(2);
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

  it('renders a full caller-supplied starter exclude list without truncation', () => {
    const starterExcludes = [
      '**/.git/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/target/**',
      '**/__pycache__/**',
      '**/.venv/**',
      '**/venv/**',
    ];
    const out = renderDocumentHeader({
      schemaVersion: 1,
      globalExcludes: starterExcludes,
      targets: [TS_TARGET],
    });
    const parsed = parseYaml(out) as { globalExcludes: string[] };
    expect(parsed.globalExcludes).toEqual(starterExcludes);
  });

  it('produces a document the host declarations accept (no drift)', () => {
    const out = renderDocumentHeader({ schemaVersion: 1, targets: [TS_TARGET] });
    const parsed = parseYaml(out);
    const schema = composeConfigSchema(hostConfigDeclarations());
    expect(() => validateConfigDocument(schema, parsed)).not.toThrow();
  });

  it('round-trips YAML-sensitive strings and an empty target exclude list', () => {
    const target: TargetTemplateInput = {
      name: 'api-source',
      description: 'API: backend # primary',
      languages: ['type:script', 'null'],
      concerns: ['backend # primary'],
      include: ['src/"quoted"/**', 'src/line\nbreak.ts'],
      exclude: [],
    };
    const globalExcludes = ['**/"quoted"/**', '**/line\nbreak/**'];
    const out = renderDocumentHeader({
      schemaVersion: 1,
      globalExcludes,
      targets: [target],
    });
    const parsed = parseYaml(out) as {
      globalExcludes: string[];
      targets: Record<string, Omit<TargetTemplateInput, 'name'>>;
    };

    expect(parsed.globalExcludes).toEqual(globalExcludes);
    expect(parsed.targets['api-source']).toEqual({
      description: target.description,
      languages: target.languages,
      concerns: target.concerns,
      include: target.include,
      exclude: [],
    });
    const schema = composeConfigSchema(hostConfigDeclarations());
    expect(() => validateConfigDocument(schema, parsed)).not.toThrow();
  });

  it('renders empty document collections as collections rather than null', () => {
    const out = renderDocumentHeader({
      schemaVersion: 1,
      globalExcludes: [],
      targets: [],
    });
    const parsed = parseYaml(out);

    expect(parsed).toEqual({ schemaVersion: 1, globalExcludes: [], targets: {} });
    const schema = composeConfigSchema(hostConfigDeclarations());
    expect(() => validateConfigDocument(schema, parsed)).not.toThrow();
  });
});
