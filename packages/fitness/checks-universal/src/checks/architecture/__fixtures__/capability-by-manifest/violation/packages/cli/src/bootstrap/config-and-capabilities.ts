// Violation fixture: a NEW capability domain hardcoded host-side. registerDomain
// is called with an inline object literal instead of a manifest-derived spec —
// bypassing registerCapabilityDomainsFromManifest. Must flag.
export function wireAuditDomain(registry: CapabilityRegistry): void {
  registry.registerDomain(
    { id: 'audit-rule', ownerToolId: 'audit', apiVersion: 1, contributionKind: 'module-export' },
    auditRegistrar,
  )
}

declare class CapabilityRegistry {
  registerDomain(spec: unknown, registrar: () => void): void
}
declare function auditRegistrar(): void
