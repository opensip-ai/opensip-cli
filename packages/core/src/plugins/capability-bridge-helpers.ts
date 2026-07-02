import { pathToFileURL } from 'node:url';

import { resolvePackageEntryPoint } from './package-entry.js';

import type { CapabilityCoContribution } from '../tools/capability.js';

type ErrorConstructor = new (message: string) => Error;

/** Options for loading an isolated capability package's declared entry module. */
export interface ImportCapabilityPackageModuleOptions {
  /** Absolute package directory that owns the package.json entry metadata. */
  readonly packageDir: string;
  /** Package name used for entry-point fallback and diagnostics. */
  readonly name: string;
  /** Optional error constructor for domain-specific unreadable-entry failures. */
  readonly errorConstructor?: ErrorConstructor;
}

/**
 * Import a capability package module from its declared package entry point.
 *
 * @throws {Error} when the package has no readable entry point.
 */
export async function importCapabilityPackageModule({
  packageDir,
  name,
  errorConstructor: ErrorCtor = TypeError,
}: ImportCapabilityPackageModuleOptions): Promise<Record<string, unknown>> {
  const resolved = resolvePackageEntryPoint(packageDir, name);
  if (resolved === undefined) {
    throw new ErrorCtor(`package ${name} has no readable entry point`);
  }
  return (await import(pathToFileURL(resolved.entry).href)) as Record<string, unknown>;
}

/**
 * Read an array-shaped export from a capability package module.
 *
 * @throws {TypeError} when the export is missing or not an array.
 */
export function readCapabilityArrayExport(
  mod: Record<string, unknown>,
  exportName: string,
): readonly unknown[] {
  const value = mod[exportName];
  if (!Array.isArray(value)) {
    throw new TypeError(`capability pack export '${exportName}' must be an array`);
  }
  return value;
}

/** Normalize an optional co-contribution export into zero or more contribution values. */
export function capabilityCoContributionValues(
  value: unknown,
  exportShape: CapabilityCoContribution['exportShape'],
): readonly unknown[] {
  if (value === undefined) return [];
  if (exportShape === 'single') return [value];
  return Array.isArray(value) ? value : [];
}
