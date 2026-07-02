/**
 * @fileoverview no-host-external-capability-pack-execution — external capability
 * packs may be admitted by policy, but they must execute through the worker
 * bridge path rather than falling back to host dynamic import.
 *
 * Project-local SELF-check for ADR-0128. Inert for adopters per
 * `opensip-cli/fit/checks/README.md`.
 */
import { defineCheck } from '@opensip-cli/fitness';

const LOAD_TOOL_CAPABILITIES = 'packages/cli/src/bootstrap/load-tool-capabilities.ts';
const CORE_DISCOVERY = 'packages/core/src/plugins/capability-discovery.ts';

function normalizedPath(filePath) {
  return filePath.replaceAll('\\', '/');
}

function violation(message, suggestion, line = 1) {
  return {
    line,
    message,
    severity: 'error',
    suggestion,
    type: 'no-host-external-capability-pack-execution',
  };
}

function lineOf(content, token) {
  const index = content.indexOf(token);
  if (index < 0) return 1;
  return content.slice(0, index).split('\n').length;
}

function analyzeLoadToolCapabilities(content) {
  const violations = [];
  if (!content.includes('contributionLoader: createIsolatedContributionLoader')) {
    violations.push(
      violation(
        'Capability domain loading must pass the isolated contribution loader so worker-admitted packs cannot fall back to host import.',
        'Pass contributionLoader: createIsolatedContributionLoader(...) into loadCapabilityDomain.',
        lineOf(content, 'loadCapabilityDomain({'),
      ),
    );
  }
  if (
    !/policyDecision\.allowed\s*&&\s*resourceDecision\s*===\s*undefined/.test(content) ||
    !/did not return a capability resource decision/.test(content)
  ) {
    violations.push(
      violation(
        'Capability pack admission must fail closed when policy does not return a resource decision.',
        'Deny allowed capability-pack loads that do not include decision.resourceDecision.',
        lineOf(content, 'policyDecision.allowed'),
      ),
    );
  }
  return violations;
}

function analyzeCoreDiscovery(content) {
  const violations = [];
  if (
    !content.includes("admission.resourceDecision?.isolation === 'worker'") ||
    !content.includes('capability.discovery.isolation_unsupported')
  ) {
    violations.push(
      violation(
        'Core capability discovery must reject worker-admitted packages when no isolated loader handled them.',
        'Keep the isolation_unsupported diagnostic before the host dynamic import path.',
        lineOf(content, 'resolvePackageEntryPoint'),
      ),
    );
  }
  if (
    !/function\s+defaultPackageAdmission/.test(content) ||
    !/external capability packages require explicit host policy admission/.test(content)
  ) {
    violations.push(
      violation(
        'Core capability discovery must deny external capability packs by default.',
        'Keep defaultPackageAdmission fail-closed; the CLI policy PEP is the admission source.',
        lineOf(content, 'defaultPackageAdmission'),
      ),
    );
  }
  return violations;
}

/** Pure analysis helper for fixture tests. */
export function analyzeNoHostExternalCapabilityPackExecution(content, filePath) {
  const rel = normalizedPath(filePath);
  if (rel === LOAD_TOOL_CAPABILITIES) return analyzeLoadToolCapabilities(content);
  if (rel === CORE_DISCOVERY) return analyzeCoreDiscovery(content);
  return [];
}

export const checks = [
  defineCheck({
    id: '5d2a2e3c-984f-4f75-87f5-84451c3f8e3a',
    slug: 'no-host-external-capability-pack-execution',
    description:
      'External capability packs must execute through worker isolation instead of host dynamic import',
    scope: { languages: ['typescript'], concerns: ['architecture'] },
    tags: ['architecture', 'plugins', 'security'],
    fileTypes: ['ts'],
    analyze: (content, filePath) => analyzeNoHostExternalCapabilityPackExecution(content, filePath),
  }),
];
