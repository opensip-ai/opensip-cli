import { describe, expect, it } from 'vitest';

import { readOneExport } from '../capability-export-reader.js';

import type { CapabilityDiscoveryDiagnostic } from '../capability-discovery-types.js';

describe('readOneExport', () => {
  it('diagnoses a missing required single export', () => {
    const diagnostics: CapabilityDiscoveryDiagnostic[] = [];

    const out = readOneExport({}, '@acme/pack', (diagnostic) => diagnostics.push(diagnostic), {
      exportName: 'adapter',
      exportShape: 'single',
      required: true,
      metadataTag: {},
    });

    expect(out).toEqual([]);
    expect(diagnostics).toEqual([
      {
        evt: 'capability.discovery.bad_export',
        packageName: '@acme/pack',
        message: 'package @acme/pack does not export "adapter" — skipping',
      },
    ]);
  });

  it('silently skips missing optional arrays and tags present contributions', () => {
    expect(
      readOneExport({}, '@acme/pack', undefined, {
        exportName: 'items',
        exportShape: 'array',
        required: false,
        metadataTag: {},
      }),
    ).toEqual([]);

    expect(
      readOneExport({ items: [{ id: 'one' }] }, '@acme/pack', undefined, {
        exportName: 'items',
        exportShape: 'array',
        targetDomainId: 'extra',
        required: false,
        metadataTag: { packageTargetDomain: 'fit' },
      }),
    ).toEqual([
      {
        contribution: { id: 'one' },
        sourcePackage: '@acme/pack',
        packageTargetDomain: 'fit',
        targetDomainId: 'extra',
      },
    ]);
  });
});
