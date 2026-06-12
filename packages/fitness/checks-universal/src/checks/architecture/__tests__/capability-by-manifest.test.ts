/**
 * Unit tests for the `capability-by-manifest` guardrail.
 *
 * Two layers:
 *  1. The pure `analyzeCapabilityByManifest(content, filePath)` detector —
 *     the compliant `registerDomain(spec, …)` variable pass (0 findings), the
 *     registry's own method DEFINITION (0 findings, no receiver), and a
 *     host-compiled `registerDomain({ id: '…' })` literal (flagged).
 *  2. The full `analyzeAll` over a fake in-memory `FileAccessor`.
 */
import { describe, expect, it } from 'vitest';

import {
  analyzeAllCapabilityByManifest,
  analyzeCapabilityByManifest,
} from '../capability-by-manifest.js';

import type { FileAccessor } from '@opensip-cli/fitness';

const CAP_REGISTRY = 'packages/core/src/plugins/capability-registry.ts';
const CLI_BOOTSTRAP = 'packages/cli/src/bootstrap/config-and-capabilities.ts';

/** The compliant call: a `spec` VARIABLE derived from the manifest. */
const COMPLIANT = `
for (const decl of manifest.capabilities ?? []) {
  const spec = { id: decl.id, ownerToolId: manifest.id }
  registry.registerDomain(spec, makeDeferredRegistrar(spec))
}
`;

/** The registry's own method definition — a declaration, not a call. */
const METHOD_DEF = `
class CapabilityRegistry {
  registerDomain(spec: CapabilityDomainSpec, registrar: CapabilityRegistrar): void {
    this.domains.set(spec.id, { spec, registrar })
  }
}
`;

/** A host-compiled domain: registerDomain with an inline literal. */
const HARDCODED = `
registry.registerDomain({ id: 'audit-rule', ownerToolId: 'audit', apiVersion: 1 }, auditRegistrar)
`;

describe('analyzeCapabilityByManifest (pure detector)', () => {
  it('returns 0 findings for the compliant variable-pass call', () => {
    expect(analyzeCapabilityByManifest(COMPLIANT, CAP_REGISTRY)).toEqual([]);
  });

  it('returns 0 findings for the registry method DEFINITION', () => {
    expect(analyzeCapabilityByManifest(METHOD_DEF, CAP_REGISTRY)).toEqual([]);
  });

  it('flags a host-compiled registerDomain({ … }) literal', () => {
    const v = analyzeCapabilityByManifest(HARDCODED, CLI_BOOTSTRAP);
    expect(v).toHaveLength(1);
    expect(v[0]?.type).toBe('capability-by-manifest');
    expect(v[0]?.severity).toBe('error');
  });

  it('returns 0 findings for a non-host file even with a literal', () => {
    expect(analyzeCapabilityByManifest(HARDCODED, 'packages/graph/engine/src/tool.ts')).toEqual([]);
  });
});

/** Build a fake FileAccessor over an in-memory path→content map. */
function fakeAccessor(files: Record<string, string>): FileAccessor {
  return {
    paths: Object.keys(files),
    read: (p) => Promise.resolve(files[p] ?? ''),
    readMany: (ps) => Promise.resolve(new Map(ps.map((p) => [p, files[p] ?? '']))),
    readAll: () => Promise.resolve(new Map(Object.entries(files))),
  };
}

describe('analyzeAllCapabilityByManifest (self-targeting over the file set)', () => {
  it('returns 0 findings for the compliant host sources', async () => {
    const files = {
      [CAP_REGISTRY]: COMPLIANT + METHOD_DEF,
      [CLI_BOOTSTRAP]: COMPLIANT,
    };
    expect(await analyzeAllCapabilityByManifest(fakeAccessor(files))).toEqual([]);
  });

  it('flags a host-compiled domain literal', async () => {
    const files = { [CLI_BOOTSTRAP]: HARDCODED };
    const v = await analyzeAllCapabilityByManifest(fakeAccessor(files));
    expect(v).toHaveLength(1);
    expect(v[0]?.filePath).toBe(CLI_BOOTSTRAP);
  });
});
