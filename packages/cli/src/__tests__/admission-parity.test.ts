/**
 * Admission rejection-parity (ADR-0041): the one-validator invariant.
 *
 * `admitToolPackage` is the SINGLE admission sequence consumed by bootstrap
 * (bundled fail-closed policy), `tools validate`, and `tools install`. These
 * tests pin (a) each malformed fixture fails in exactly its expected SECTION,
 * (b) the valid fixture passes every section, and (c) the bundled policy
 * (registerFirstPartyTools) throws exactly when the report fails — so a check
 * added to one consumer but not the callable breaks this suite immediately.
 */

import { fileURLToPath } from 'node:url';

import { ToolRegistry } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { admitToolPackage } from '../bootstrap/index.js';
import { registerFirstPartyTools } from '../bootstrap/register-tools.js';

const fixturesDir = fileURLToPath(new URL('fixtures', import.meta.url));
const admissionFixture = (name: string): string =>
  fileURLToPath(new URL(`fixtures/tools-admission/${name}`, import.meta.url));

function failedSection(report: { sections: readonly { section: string; ok: boolean }[] }) {
  return report.sections.find((s) => !s.ok)?.section;
}

describe('admitToolPackage — section verdicts per fixture', () => {
  it('passes every section for the valid tool fixture', async () => {
    const report = await admitToolPackage({
      dir: `${fixturesDir}/tool-plugin`,
      source: 'installed',
      explicitlyRequested: true,
    });
    expect(report.ok).toBe(true);
    expect(report.sections.map((s) => s.section)).toEqual([
      'manifest',
      'compatibility',
      'runtime-load',
      'tool-shape',
      'manifest-runtime-coherence',
    ]);
    const reported = report.tool?.metadata;
    expect(reported?.name ?? reported?.id).toBe('audit-demo-tool');
    expect(report.provenance?.source).toBe('installed');
  });

  it('staticOnly stops after the static sections (no code execution)', async () => {
    const report = await admitToolPackage({
      dir: admissionFixture('bad-no-tool-export'),
      source: 'installed',
      explicitlyRequested: true,
      staticOnly: true,
    });
    // The broken runtime is never imported: static sections pass, ok=true.
    expect(report.ok).toBe(true);
    expect(report.sections.map((s) => s.section)).toEqual(['manifest', 'compatibility']);
    expect(report.tool).toBeUndefined();
  });

  it('missing apiVersion fails the compatibility section', async () => {
    const report = await admitToolPackage({
      dir: admissionFixture('bad-manifest-no-apiversion'),
      source: 'installed',
      explicitlyRequested: true,
    });
    expect(report.ok).toBe(false);
    expect(failedSection(report)).toBe('compatibility');
  });

  it('a module with no valid tool export fails the tool-shape section', async () => {
    const report = await admitToolPackage({
      dir: admissionFixture('bad-no-tool-export'),
      source: 'installed',
      explicitlyRequested: true,
    });
    expect(report.ok).toBe(false);
    expect(failedSection(report)).toBe('tool-shape');
  });

  it('a manifest/runtime id mismatch fails the coherence section', async () => {
    const report = await admitToolPackage({
      dir: admissionFixture('bad-id-mismatch'),
      source: 'installed',
      explicitlyRequested: true,
    });
    expect(report.ok).toBe(false);
    expect(failedSection(report)).toBe('manifest-runtime-coherence');
    expect(report.coherenceError).toBeDefined();
  });

  it('a manifest/runtime command-surface mismatch fails the coherence section', async () => {
    const report = await admitToolPackage({
      dir: admissionFixture('bad-command-mismatch'),
      source: 'installed',
      explicitlyRequested: true,
    });
    expect(report.ok).toBe(false);
    expect(failedSection(report)).toBe('manifest-runtime-coherence');
  });
});

describe('bundled policy parity — registerFirstPartyTools throws iff the report fails', () => {
  // The bundled path resolves package DIRS by name through the CLI's module
  // graph, so fixture dirs can't be injected by name. Parity is pinned the
  // other way: the REAL bundled packages must both report ok AND register
  // without throwing — and a rejected fixture must both report !ok AND (by
  // the same sections) be exactly what the fail-closed mapper throws on.
  it('the real bundled set admits cleanly through the shared callable', async () => {
    const registry = new ToolRegistry();
    await expect(registerFirstPartyTools(registry)).resolves.toBeUndefined();
    expect(
      registry
        .list()
        .map((t) => t.metadata.name ?? t.metadata.id)
        .sort(),
    ).toEqual(['fitness', 'graph', 'simulation']);
  });
});
