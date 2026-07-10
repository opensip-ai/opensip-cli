/** Bounded plain-data capture for the runtime tool identity index. */

import {
  buildToolIdentityIndex,
  ToolRegistry,
  validateToolIdentity,
  type Tool,
  type ToolIdentity,
} from '@opensip-cli/core';

import { hasControlCharacter } from './control-text.js';
import {
  readOwnRuntimeProperty,
  reserveRuntimeFact,
  type CapturedRuntimeTool,
  type MutableRuntimeSnapshot,
  type RuntimeToolIdentityIndex,
} from './runtime-wiring-capture.js';

const MAX_RUNTIME_IDENTITY_TEXT = 256;

interface CapturedIdentityCandidate {
  readonly captured: CapturedRuntimeTool;
  readonly indexedTool: Tool;
  readonly identityInputs: readonly string[];
}

interface OptionalText {
  readonly valid: boolean;
  readonly value?: string;
}

function boundedIdentityText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  let length = 0;
  for (const char of value) {
    if (length >= MAX_RUNTIME_IDENTITY_TEXT || hasControlCharacter(char)) return undefined;
    length++;
  }
  return value;
}

function requiredText(target: object, key: PropertyKey): string | undefined {
  const property = readOwnRuntimeProperty(target, key);
  return property.kind === 'data' ? boundedIdentityText(property.value) : undefined;
}

function optionalText(target: object, key: PropertyKey): OptionalText {
  const property = readOwnRuntimeProperty(target, key);
  if (property.kind === 'missing' || (property.kind === 'data' && property.value === undefined)) {
    return { valid: true };
  }
  const value = property.kind === 'data' ? boundedIdentityText(property.value) : undefined;
  return value === undefined ? { valid: false } : { valid: true, value };
}

function safeArray(value: unknown): value is readonly unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function captureAliases(
  identity: object,
  state: MutableRuntimeSnapshot,
): readonly string[] | undefined {
  const property = readOwnRuntimeProperty(identity, 'aliases');
  if (property.kind === 'missing' || (property.kind === 'data' && property.value === undefined)) {
    return [];
  }
  if (property.kind !== 'data' || !safeArray(property.value)) return undefined;
  const lengthProperty = readOwnRuntimeProperty(property.value, 'length');
  const length = lengthProperty.kind === 'data' ? lengthProperty.value : undefined;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return undefined;

  const aliases: string[] = [];
  for (let index = 0; index < length; index++) {
    if (!reserveRuntimeFact(state)) return undefined;
    const aliasProperty = readOwnRuntimeProperty(property.value, String(index));
    const alias =
      aliasProperty.kind === 'data' ? boundedIdentityText(aliasProperty.value) : undefined;
    if (alias === undefined) return undefined;
    aliases.push(alias);
  }
  return Object.freeze(aliases);
}

function nestedOptionalText(
  target: object,
  outerKey: PropertyKey,
  innerKey: PropertyKey,
): OptionalText {
  const outer = readOwnRuntimeProperty(target, outerKey);
  if (outer.kind === 'missing' || (outer.kind === 'data' && outer.value === undefined)) {
    return { valid: true };
  }
  if (outer.kind !== 'data' || outer.value === null || typeof outer.value !== 'object') {
    return { valid: false };
  }
  return optionalText(outer.value, innerKey);
}

function sessionReplayTool(tool: Tool): OptionalText {
  const extensionPoints = readOwnRuntimeProperty(tool, 'extensionPoints');
  if (
    extensionPoints.kind === 'missing' ||
    (extensionPoints.kind === 'data' && extensionPoints.value === undefined)
  ) {
    return { valid: true };
  }
  if (
    extensionPoints.kind !== 'data' ||
    extensionPoints.value === null ||
    typeof extensionPoints.value !== 'object'
  ) {
    return { valid: false };
  }
  return nestedOptionalText(extensionPoints.value, 'sessionReplay', 'tool');
}

function noSessionReplay(): null {
  return null;
}

function captureIdentityCandidate(
  tool: Tool,
  state: MutableRuntimeSnapshot,
): CapturedIdentityCandidate | undefined {
  if (!reserveRuntimeFact(state)) return undefined;
  const identityProperty = readOwnRuntimeProperty(tool, 'identity');
  const metadataProperty = readOwnRuntimeProperty(tool, 'metadata');
  if (
    identityProperty.kind !== 'data' ||
    identityProperty.value === null ||
    typeof identityProperty.value !== 'object' ||
    metadataProperty.kind !== 'data' ||
    metadataProperty.value === null ||
    typeof metadataProperty.value !== 'object'
  ) {
    return undefined;
  }

  const name = requiredText(identityProperty.value, 'name');
  const aliases = captureAliases(identityProperty.value, state);
  const layoutKey = optionalText(identityProperty.value, 'layoutKey');
  const pluginDomain = nestedOptionalText(tool, 'pluginLayout', 'domain');
  const replayTool = sessionReplayTool(tool);
  const stableId = requiredText(metadataProperty.value, 'id');
  const version = requiredText(metadataProperty.value, 'version');
  if (
    name === undefined ||
    aliases === undefined ||
    !layoutKey.valid ||
    !pluginDomain.valid ||
    !replayTool.valid ||
    stableId === undefined ||
    version === undefined
  ) {
    return undefined;
  }

  const identity: ToolIdentity = Object.freeze({
    name,
    aliases,
    ...(layoutKey.value === undefined ? {} : { layoutKey: layoutKey.value }),
  });
  let validIdentity = true;
  try {
    validateToolIdentity(identity);
  } catch {
    validIdentity = false;
    state.reasons.add('tool-identity-invalid-or-accessor');
  }
  if (!validIdentity) return undefined;
  const effectiveLayout = pluginDomain.value ?? replayTool.value ?? layoutKey.value ?? name;
  const indexedTool: Tool = Object.freeze({
    identity,
    metadata: Object.freeze({ id: stableId, name, version, description: 'captured runtime tool' }),
    commandSpecs: Object.freeze([]),
    ...(pluginDomain.value === undefined
      ? {}
      : {
          pluginLayout: Object.freeze({
            domain: pluginDomain.value,
            userSubdirs: Object.freeze([]),
          }),
        }),
    ...(replayTool.value === undefined
      ? {}
      : {
          extensionPoints: Object.freeze({
            sessionReplay: Object.freeze({
              tool: replayTool.value,
              replaySession: noSessionReplay,
            }),
          }),
        }),
  });
  return {
    captured: Object.freeze({ source: tool, canonicalName: name, stableId, version }),
    indexedTool,
    identityInputs: Object.freeze([
      name,
      ...aliases,
      effectiveLayout,
      ...(replayTool.value === undefined ? [] : [replayTool.value]),
      ...(pluginDomain.value === undefined ? [] : [pluginDomain.value]),
    ]),
  };
}

function emptyIdentityIndex(): RuntimeToolIdentityIndex {
  return buildToolIdentityIndex(new ToolRegistry());
}

/** Capture a bounded registry subset and build core's index only from safe plain data. */
export function captureRuntimeToolIdentities(
  registry: ToolRegistry,
  state: MutableRuntimeSnapshot,
): {
  readonly tools: readonly CapturedRuntimeTool[];
  readonly identityIndex: RuntimeToolIdentityIndex;
} {
  const boundedRegistry = new ToolRegistry();
  const tools: CapturedRuntimeTool[] = [];
  const canonicalNames = new Set<string>();
  const inputOwners = new Map<string, string>();
  for (const tool of registry.values()) {
    const candidate = captureIdentityCandidate(tool, state);
    if (candidate === undefined) {
      if (state.factTruncated) break;
      state.reasons.add('tool-identity-invalid-or-accessor');
      continue;
    }
    const canonical = candidate.captured.canonicalName;
    const conflict =
      canonicalNames.has(canonical) ||
      candidate.identityInputs.some((input) => {
        const owner = inputOwners.get(input);
        return owner !== undefined && owner !== canonical;
      });
    if (conflict) {
      state.reasons.add('tool-identity-conflict');
      continue;
    }
    canonicalNames.add(canonical);
    for (const input of candidate.identityInputs) inputOwners.set(input, canonical);
    boundedRegistry.register(candidate.indexedTool);
    tools.push(candidate.captured);
  }
  try {
    return { tools: Object.freeze(tools), identityIndex: buildToolIdentityIndex(boundedRegistry) };
  } catch {
    state.reasons.add('tool-identity-invalid-or-accessor');
    return { tools: Object.freeze([]), identityIndex: emptyIdentityIndex() };
  }
}
