// Clean fixture: the compliant manifest-driven path. The single registerDomain
// CALL passes a `spec` VARIABLE derived from manifest.capabilities; the registry
// method DEFINITION takes a typed param (no receiver). 0 findings.
export function registerCapabilityDomainsFromManifest(
  manifest: { id: string; capabilities?: readonly { id: string; apiVersion: number }[] },
  registry: CapabilityRegistry,
): void {
  for (const decl of manifest.capabilities ?? []) {
    const spec = { id: decl.id, ownerToolId: manifest.id, apiVersion: decl.apiVersion }
    registry.registerDomain(spec, makeDeferredRegistrar(spec))
  }
}

class CapabilityRegistry {
  registerDomain(spec: { id: string }, registrar: () => void): void {
    void spec
    void registrar
  }
}

declare function makeDeferredRegistrar(spec: unknown): () => void
