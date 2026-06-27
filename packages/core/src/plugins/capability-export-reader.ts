import type {
  CapabilityDiscoveryDiagnostic,
  RawCapabilityContribution,
} from './capability-discovery-types.js';

/** Which export to read from a package module, and how. */
interface ExportSpec {
  readonly exportName: string;
  readonly exportShape: 'array' | 'single';
  /** The domain co-contributions route to; undefined = the primary domain. */
  readonly targetDomainId?: string;
  /** When true, a missing/wrong-shape export is diagnosed; when false, silent (optional co-export). */
  readonly required: boolean;
  /** Package-level target metadata attached to every yielded contribution. */
  readonly metadataTag: {
    readonly packageTargetDomain?: string;
    readonly packageTargetDomainApiVersion?: number;
  };
}

/**
 * Read one export (`mod[spec.exportName]`) per `spec.exportShape`, tagging each
 * contribution with `spec.targetDomainId` (undefined = the primary domain).
 * `spec.required` governs the missing-export behavior: a missing PRIMARY export
 * is diagnosed + skipped; a missing co-contribution export is silent.
 */
export function readOneExport(
  mod: Record<string, unknown>,
  sourcePackage: string,
  onDiagnostic: ((d: CapabilityDiscoveryDiagnostic) => void) | undefined,
  spec: ExportSpec,
): RawCapabilityContribution[] {
  const { exportName, exportShape, targetDomainId, required, metadataTag } = spec;
  const tag = {
    ...metadataTag,
    ...(targetDomainId === undefined ? {} : { targetDomainId }),
  };
  const value = mod[exportName];
  if (exportShape === 'array') {
    if (value === undefined && !required) return [];
    if (!Array.isArray(value)) {
      if (required) {
        onDiagnostic?.({
          evt: 'capability.discovery.bad_export',
          packageName: sourcePackage,
          message: `package ${sourcePackage} does not export a "${exportName}" array — skipping`,
        });
      }
      return [];
    }
    return (value as readonly unknown[]).map((contribution) => ({
      contribution,
      sourcePackage,
      ...tag,
    }));
  }
  if (value === undefined) {
    if (required) {
      onDiagnostic?.({
        evt: 'capability.discovery.bad_export',
        packageName: sourcePackage,
        message: `package ${sourcePackage} does not export "${exportName}" — skipping`,
      });
    }
    return [];
  }
  return [{ contribution: value, sourcePackage, ...tag }];
}
