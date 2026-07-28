/**
 * Defensive structural readers for untrusted `commandSpecs` shapes, plus the single
 * failure funnel they raise through.
 *
 * WHY THIS IS A SEPARATE MODULE
 * `build-runtime-command-inventory.ts` projects an inventory from objects supplied by
 * arbitrary Tool plugins. Every field it reads is therefore untrusted: it may be absent,
 * an accessor that throws, a proxy, or the wrong type entirely. That defensiveness is a
 * cohesive concern with its own vocabulary (`OwnProperty`, own-data-only reads), and it
 * is what pushed the projection module past the file-size guardrail. Splitting it keeps
 * both halves readable and lets the readers be reasoned about — and tested — on their own.
 *
 * The reads are own-data-only by construction: a getter is never invoked, so a hostile
 * plugin cannot execute code during inventory projection.
 */

import { PluginIncompatibleError, type StaticHandlerDescriptor } from '@opensip-cli/core';

import { hostErrorCatalog } from '../errors/host-error-catalog.js';

const RUNTIME_INVENTORY_INVALID = hostErrorCatalog.require('CLI.RUNTIME_INVENTORY.INVALID');

/**
 * The one failure funnel for a rejected `commandSpecs` shape.
 *
 * `metadata.condition` names which structural rule broke (D9) so the plugin author does
 * not have to parse the message to find out; the code stays single because the action is
 * always the same — fix the declared command surface.
 *
 * @throws {PluginIncompatibleError} always — inventory rejected a commandSpecs shape
 */
export function inventoryError(
  message: string,
  condition: string,
  metadata: Readonly<Record<string, unknown>> = {},
): never {
  throw new PluginIncompatibleError(message, {
    code: RUNTIME_INVENTORY_INVALID.code,
    definition: RUNTIME_INVENTORY_INVALID,
    metadata: { condition, ...metadata },
    diagnostic: condition,
  });
}

/**
 * Outcome of an own-property read.
 *
 * `accessor` and `invalid` are kept distinct from `missing` so callers can refuse a
 * getter-backed field rather than silently treating it as absent.
 */
export type OwnProperty =
  | { readonly kind: 'data'; readonly value: unknown }
  | { readonly kind: 'missing' | 'accessor' | 'invalid' };

export function readOwn(target: object, key: PropertyKey): OwnProperty {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor === undefined) return { kind: 'missing' };
    if (!('value' in descriptor)) return { kind: 'accessor' };
    return { kind: 'data', value: descriptor.value };
  } catch {
    return { kind: 'invalid' };
  }
}

export function ownData(target: object, key: PropertyKey): unknown {
  const property = readOwn(target, key);
  return property.kind === 'data' ? property.value : undefined;
}

export function readString(target: object, key: PropertyKey): string | undefined {
  const value = ownData(target, key);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function readStringArray(target: object, key: PropertyKey): readonly string[] {
  const value = ownData(target, key);
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = readOwn(value, String(i));
    if (item.kind === 'data' && typeof item.value === 'string' && item.value !== '') {
      out.push(item.value);
    }
  }
  return out;
}

/**
 * Read an optional static-handler descriptor from a command-spec object.
 *
 * @throws {PluginIncompatibleError} When `staticHandler` is present but not a plain data
 *   object or is missing required package/path/declaration fields.
 */
export function readStaticHandler(target: object): StaticHandlerDescriptor | undefined {
  const property = readOwn(target, 'staticHandler');
  if (property.kind === 'missing') return undefined;
  if (property.kind !== 'data' || property.value === null || typeof property.value !== 'object') {
    inventoryError(
      'runtime inventory: staticHandler must be own data plain object.',
      'static-handler-shape',
    );
  }
  const descriptor = property.value;
  const pkg = readString(descriptor, 'package');
  const path = readString(descriptor, 'path');
  const declaration = readString(descriptor, 'declaration');
  if (pkg === undefined || path === undefined || declaration === undefined) {
    inventoryError(
      'runtime inventory: staticHandler missing package/path/declaration.',
      'static-handler-fields',
    );
  }
  return { package: pkg, path, declaration };
}
