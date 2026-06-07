/**
 * @fileoverview A capability domain must reach the registry from a MANIFEST,
 * not be host-compiled (release 2.10.0, §5.3 / ADR-0023 / north-star
 * Principle 6).
 *
 * The capability model turns "which extension points a tool owns" into DATA: a
 * tool declares its domains in `package.json#opensipTools.capabilities`, and
 * the host registers each one via `registerCapabilityDomainsFromManifest`
 * (reading `manifest.capabilities`) into the per-run `CapabilityRegistry`. The
 * host is NOT compiled to understand any specific domain — `MARKER_KINDS`
 * remains only the bootstrap-default discovery vocabulary, which a
 * manifest-declared domain EXTENDS.
 *
 * The violation this guardrail catches: a NEW capability domain hardcoded into
 * a host file — a `registry.registerDomain({ id: '<literal>' … })` call that
 * builds a `CapabilityDomainSpec` from an inline object literal instead of
 * from a manifest declaration. The single legitimate `registerDomain` call
 * site is inside `registerCapabilityDomainsFromManifest`, where it passes a
 * `spec` VARIABLE derived from `manifest.capabilities` (`registerDomain(spec, …)`).
 * Any `registerDomain({ … })` with an inline literal is a host-compiled domain
 * that bypassed the manifest path.
 *
 * SELF-TARGETING — the check scans opensip-tools' own host sources
 * (`packages/{core,cli}/** /src/**`). The one compliant `registerDomain` call
 * passes a variable (not a literal), so it does not match; the registry's own
 * METHOD DEFINITION (`registerDomain(spec: CapabilityDomainSpec, …)`) is a
 * declaration, not a call, and is excluded by requiring a receiver
 * (`<obj>.registerDomain(`).
 *
 * SCOPE — opensip-tools' own monorepo host packages. Inert in adopter repos
 * (whose code never calls the kernel's `registerDomain`).
 */
import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/fitness'

/** Host packages that own capability routing (core kernel + cli composition root). */
const HOST_SRC_PATH = /packages\/(?:core|cli)\/(?:[^/]+\/)?src\//

/**
 * A `<receiver>.registerDomain(` call whose FIRST argument opens an inline
 * object literal `{` (a host-compiled `CapabilityDomainSpec`). The receiver
 * group ensures we match a method CALL on a registry, not the registry class's
 * own method DEFINITION (`registerDomain(spec: …)`, no receiver). The `{`
 * (after optional whitespace, which spans newlines so a multi-line call still
 * matches) is what distinguishes a hardcoded domain literal from the compliant
 * `registerDomain(spec, …)` variable pass. The `g` flag drives an over-content
 * scan so the per-match line number is derived from the match index.
 */
const HARDCODED_DOMAIN_RE = /\b[A-Za-z_$][\w$]*\.registerDomain\s*\(\s*\{/g

/** 1-based line number of a character offset within `content`. */
function lineOf(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++
  }
  return line
}

/**
 * Pure analysis over one host source file. Flags each
 * `<registry>.registerDomain({ … })` call — a host-compiled domain spec that
 * bypasses the manifest declaration path. Exported for unit tests.
 */
export function analyzeCapabilityByManifest(content: string, filePath: string): CheckViolation[] {
  if (!HOST_SRC_PATH.test(filePath)) return []
  const violations: CheckViolation[] = []
  for (const m of content.matchAll(HARDCODED_DOMAIN_RE)) {
    violations.push({
      line: lineOf(content, m.index ?? 0),
      filePath,
      message:
        `Host-compiled capability domain: registerDomain({ … }) builds a ` +
        `CapabilityDomainSpec from an inline literal. A domain must reach the ` +
        `registry from a tool's manifest via registerCapabilityDomainsFromManifest ` +
        `(reading package.json#opensipTools.capabilities), not be hardcoded host-side (ADR-0023, §5.3).`,
      severity: 'error',
      suggestion:
        `Declare the domain in the owning tool's manifest ` +
        `(package.json#opensipTools.capabilities: [{ id, apiVersion, contributionKind, contributionSchema }]) ` +
        `and let registerCapabilityDomainsFromManifest register it; supply the runtime ` +
        `registrar via Tool.capabilityRegistrars. MARKER_KINDS is the only allowed ` +
        `bootstrap default — a new domain is DATA, not a host enum/literal.`,
      type: 'capability-by-manifest',
    })
  }
  return violations
}

/**
 * Walk every host-package source file in the scanned set and run
 * {@link analyzeCapabilityByManifest}. Non-host files contribute nothing.
 * Exported so unit tests can drive it with an in-memory `FileAccessor`.
 */
export async function analyzeAllCapabilityByManifest(files: FileAccessor): Promise<CheckViolation[]> {
  const violations: CheckViolation[] = []
  const candidates = files.paths.filter(
    (p) => HOST_SRC_PATH.test(p) && p.endsWith('.ts') && !p.endsWith('.test.ts'),
  )
  const contents = await files.readMany(candidates)
  for (const [filePath, content] of contents) {
    violations.push(...analyzeCapabilityByManifest(content, filePath))
  }
  return violations
}

export const capabilityByManifest = defineCheck({
  id: 'd93d27f6-f1a0-45e8-a469-22b78cef4dc2',
  slug: 'capability-by-manifest',
  description:
    'A capability domain must be declared in a tool manifest and registered via registerCapabilityDomainsFromManifest, not host-compiled (ADR-0023, §5.3)',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture'],
  fileTypes: ['ts'],
  // raw content: we detect a code-level `.registerDomain({` call, so prose
  // mentioning capability domains does not false-fire.
  contentFilter: 'raw',
  analyzeAll: analyzeAllCapabilityByManifest,
})
