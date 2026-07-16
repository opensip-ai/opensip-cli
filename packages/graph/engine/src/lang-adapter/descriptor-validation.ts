import type { GraphLanguageAdapter } from './types.js';

const MAX_ADAPTER_ID = 64;
const MAX_DISPLAY_NAME = 128;
const MAX_EXTENSIONS = 32;
const MAX_EXTENSION = 32;
const ADAPTER_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/;
const FILE_EXTENSION = /^\.[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,30})$/;

export interface GraphAdapterDescriptor {
  readonly id: string;
  readonly fileExtensions: readonly string[];
  readonly displayName?: string;
}

function isSafeText(value: string, max: number): boolean {
  if (value.length === 0 || value.length > max) return false;
  return !/\p{Cc}/u.test(value);
}

/** Validate metadata before it reaches selector glob construction or a host proxy. */
export function isSafeGraphAdapterMetadata(value: unknown): value is GraphAdapterDescriptor {
  if (typeof value !== 'object' || value === null) return false;
  const descriptor = value as Record<string, unknown>;
  if (
    typeof descriptor.id !== 'string' ||
    !isSafeText(descriptor.id, MAX_ADAPTER_ID) ||
    !ADAPTER_ID.test(descriptor.id)
  ) {
    return false;
  }
  if (
    descriptor.displayName !== undefined &&
    (typeof descriptor.displayName !== 'string' ||
      !isSafeText(descriptor.displayName, MAX_DISPLAY_NAME))
  ) {
    return false;
  }
  if (
    !Array.isArray(descriptor.fileExtensions) ||
    descriptor.fileExtensions.length > MAX_EXTENSIONS
  ) {
    return false;
  }
  return descriptor.fileExtensions.every(
    (extension) =>
      typeof extension === 'string' &&
      isSafeText(extension, MAX_EXTENSION) &&
      FILE_EXTENSION.test(extension),
  );
}

/** Validate the full callable graph-adapter contract. */
export function isSafeGraphAdapterDescriptor(value: unknown): value is GraphLanguageAdapter {
  if (!isSafeGraphAdapterMetadata(value)) return false;
  const adapter = value as unknown as Record<string, unknown>;
  return (
    typeof adapter.discoverFiles === 'function' &&
    typeof adapter.parseProject === 'function' &&
    typeof adapter.walkProject === 'function' &&
    typeof adapter.resolveCallSites === 'function' &&
    typeof adapter.cacheKey === 'function'
  );
}
