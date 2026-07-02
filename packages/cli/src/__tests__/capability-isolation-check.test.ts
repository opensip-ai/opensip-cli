import { describe, expect, it } from 'vitest';

import { analyzeNoHostExternalCapabilityPackExecution } from '../../../../opensip-cli/fit/checks/no-host-external-capability-pack-execution.mjs';

describe('analyzeNoHostExternalCapabilityPackExecution', () => {
  it('accepts the CLI load seam when it wires the isolated loader and fails closed', () => {
    const content = `
      await loadCapabilityDomain({
        registry,
        domainId: domain.id,
        contributionLoader: createIsolatedContributionLoader({ owningTool, domainId: domain.id, projectDir }),
      });
      if (policyDecision.allowed && resourceDecision === undefined) {
        return { admit: false, reason: 'policy allowed pkg but did not return a capability resource decision' };
      }
    `;

    expect(
      analyzeNoHostExternalCapabilityPackExecution(
        content,
        'packages/cli/src/bootstrap/load-tool-capabilities.ts',
      ),
    ).toEqual([]);
  });

  it('flags a CLI load seam that omits the isolated contribution loader', () => {
    const content = `
      await loadCapabilityDomain({
        registry,
        domainId: domain.id,
      });
      if (policyDecision.allowed && resourceDecision === undefined) {
        return { admit: false, reason: 'policy allowed pkg but did not return a capability resource decision' };
      }
    `;

    const violations = analyzeNoHostExternalCapabilityPackExecution(
      content,
      'packages/cli/src/bootstrap/load-tool-capabilities.ts',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('isolated contribution loader');
  });

  it('flags core discovery when worker isolation can fall through to host import', () => {
    const content = `
      function defaultPackageAdmission() {
        return { admit: false, reason: 'external capability packages require explicit host policy admission' };
      }
      const resolved = resolvePackageEntryPoint(pkg.packageDir, pkg.name);
      const mod = await import(pathToFileURL(resolved.entry).href);
    `;

    const violations = analyzeNoHostExternalCapabilityPackExecution(
      content,
      'packages/core/src/plugins/capability-discovery.ts',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('worker-admitted packages');
  });

  it('flags core discovery when default admission stops denying external packs', () => {
    const content = `
      if (admission.resourceDecision?.isolation === 'worker') {
        onDiagnostic?.({ evt: 'capability.discovery.isolation_unsupported' });
        return [];
      }
      function defaultPackageAdmission() {
        return { admit: true };
      }
    `;

    const violations = analyzeNoHostExternalCapabilityPackExecution(
      content,
      'packages/core/src/plugins/capability-discovery.ts',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('deny external capability packs by default');
  });
});
