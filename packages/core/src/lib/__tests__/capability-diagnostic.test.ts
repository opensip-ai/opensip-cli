/**
 * capability-diagnostic — mapping capability discovery events to typed
 * {@link CliDiagnostic}s. Focus: the foreign-core / scope-ABI-mismatch event gets
 * its own code + a remediation action, instead of the generic domain-load bucket.
 */

import { describe, expect, it } from 'vitest';

import { capabilityDiscoveryToCliDiagnostic } from '../capability-diagnostic.js';
import { CLI_DIAGNOSTIC_CODES } from '../cli-diagnostic.js';

describe('capabilityDiscoveryToCliDiagnostic', () => {
  it('maps a foreign-core event to the scope-ABI-mismatch code with an align action', () => {
    const diag = capabilityDiscoveryToCliDiagnostic(
      {
        evt: 'capability.discovery.foreign_core',
        packageName: '@acme/fit',
        message: 'package @acme/fit was built against @opensip-cli/core 0.1.15 ...',
      },
      'fit-pack',
      { toolId: 'fitness' },
    );
    expect(diag.code).toBe(CLI_DIAGNOSTIC_CODES.OPENSIP_CAPABILITY_SCOPE_ABI_MISMATCH);
    expect(diag.message).toContain('@acme/fit');
    expect(diag.action).toMatch(/scope ABI/i);
    expect(diag.provenance?.packageName).toBe('@acme/fit');
    expect(diag.provenance?.capabilityDomain).toBe('fit-pack');
  });

  it('still routes a generic load failure to the domain-load-failed bucket', () => {
    const diag = capabilityDiscoveryToCliDiagnostic(
      { evt: 'capability.discovery.unreadable_package', packageName: 'x', message: 'boom' },
      'fit-pack',
    );
    expect(diag.code).toBe(CLI_DIAGNOSTIC_CODES.OPENSIP_CAPABILITY_DOMAIN_LOAD_FAILED);
  });
});
