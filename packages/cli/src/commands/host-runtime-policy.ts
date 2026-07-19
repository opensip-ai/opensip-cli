/**
 * Closed host-command runtime policy vocabulary and CommandSpec decoration.
 *
 * Tool CommandSpecs never flow through this module; it is a CLI-private trust
 * boundary applied after core validates the public command contract.
 */

import { defineCommand, type CommandScopeRequirement, type CommandSpec } from '@opensip-cli/core';

/** Additional shared runtime resources required by a CLI-owned host command. */
export type HostRuntimeAccess = 'default' | 'user-state' | 'project-and-user-state';

/** Bootstrap posture for a CLI-owned host command. */
export type HostBootstrapMode = 'standard' | 'inspection-only';

/** Frozen CLI-private policy copied into the command-scope index. */
export interface HostCommandRuntimePolicy {
  readonly runtimeAccess: HostRuntimeAccess;
  readonly bootstrapMode: HostBootstrapMode;
}

export const DEFAULT_HOST_RUNTIME_POLICY: HostCommandRuntimePolicy = Object.freeze({
  runtimeAccess: 'default',
  bootstrapMode: 'standard',
});
const INSPECTION_ONLY = 'inspection-only' as const;
const HOST_RUNTIME_ACCESS_VALUES = new Set<unknown>([
  'default',
  'user-state',
  'project-and-user-state',
]);
const HOST_BOOTSTRAP_MODE_VALUES = new Set<unknown>(['standard', INSPECTION_ONLY]);

/** A core CommandSpec decorated with CLI-private host runtime facts. */
export type HostRuntimeCommandSpec<TOpts = unknown, TCtx = unknown> = CommandSpec<TOpts, TCtx> & {
  readonly hostRuntimePolicy?: HostCommandRuntimePolicy;
};

/** @throws {TypeError} When the policy is not a closed plain data object. */
function validatePolicyObject(policy: Partial<HostCommandRuntimePolicy>): void {
  const prototype = Object.getPrototypeOf(policy) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Host runtime policy must be a plain object.');
  }
  const allowed = new Set(['runtimeAccess', 'bootstrapMode']);
  for (const key of Reflect.ownKeys(policy)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(`Unsupported host runtime policy field '${String(key)}'.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(policy, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`Host runtime policy field '${key}' must be an own data property.`);
    }
  }
}

function ownPolicyValue(
  policy: Partial<HostCommandRuntimePolicy>,
  key: keyof HostCommandRuntimePolicy,
  fallback: HostRuntimeAccess | HostBootstrapMode,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(policy, key);
  return descriptor === undefined ? fallback : descriptor.value;
}

/** @throws {TypeError} When a policy field has an unsupported value or shape. */
function freezeHostRuntimePolicy(
  policy: Partial<HostCommandRuntimePolicy> | undefined,
): HostCommandRuntimePolicy {
  const candidate = policy ?? {};
  validatePolicyObject(candidate);
  const runtimeAccess = ownPolicyValue(
    candidate,
    'runtimeAccess',
    DEFAULT_HOST_RUNTIME_POLICY.runtimeAccess,
  );
  const bootstrapMode = ownPolicyValue(
    candidate,
    'bootstrapMode',
    DEFAULT_HOST_RUNTIME_POLICY.bootstrapMode,
  );
  if (!HOST_RUNTIME_ACCESS_VALUES.has(runtimeAccess)) {
    throw new TypeError(`Unsupported host runtime access '${String(runtimeAccess)}'.`);
  }
  if (!HOST_BOOTSTRAP_MODE_VALUES.has(bootstrapMode)) {
    throw new TypeError(`Unsupported host bootstrap mode '${String(bootstrapMode)}'.`);
  }
  return Object.freeze({
    runtimeAccess: runtimeAccess as HostRuntimeAccess,
    bootstrapMode: bootstrapMode as HostBootstrapMode,
  });
}

/**
 * Validate/freeze the ordinary public CommandSpec first, then create a new
 * frozen host-only decorated copy. Unknown host fields never enter core.
 *
 * @throws {TypeError} When the host runtime policy is invalid or incompatible
 *   with the command's declared scope.
 */
export function defineHostCommand<TOpts = unknown, TCtx = unknown>(
  spec: CommandSpec<TOpts, TCtx>,
  policy?: Partial<HostCommandRuntimePolicy>,
): HostRuntimeCommandSpec<TOpts, TCtx> {
  const defined = defineCommand(spec);
  if (policy === undefined) return Object.freeze({ ...defined });
  const frozenPolicy = freezeHostRuntimePolicy(policy);
  if (
    frozenPolicy.bootstrapMode === INSPECTION_ONLY &&
    (defined.scope !== 'none' || frozenPolicy.runtimeAccess !== 'default')
  ) {
    throw new TypeError(
      'Inspection-only bootstrap is limited to scope-none host commands with default runtime access.',
    );
  }
  return Object.freeze({
    ...defined,
    hostRuntimePolicy: frozenPolicy,
  });
}

/** Normalize an optional decorated policy into the closed default vocabulary. */
export function resolveHostRuntimePolicy(
  policy: HostCommandRuntimePolicy | undefined,
): HostCommandRuntimePolicy {
  return policy === undefined ? DEFAULT_HOST_RUNTIME_POLICY : freezeHostRuntimePolicy(policy);
}

/**
 * Validate the policy/scope relation at the host inventory trust boundary.
 *
 * @throws {TypeError} When inspection-only bootstrap is paired with a
 *   stateful scope or runtime-access posture.
 */
export function resolveHostRuntimePolicyForScope(
  scope: CommandScopeRequirement,
  policy: HostCommandRuntimePolicy | undefined,
): HostCommandRuntimePolicy {
  const resolved = resolveHostRuntimePolicy(policy);
  if (
    resolved.bootstrapMode === INSPECTION_ONLY &&
    (scope !== 'none' || resolved.runtimeAccess !== 'default')
  ) {
    throw new TypeError(
      'Inspection-only bootstrap is limited to scope-none host commands with default runtime access.',
    );
  }
  return resolved;
}

/** Whether stabilization must compare the path-stable project coordination key. */
export function hostPolicyNeedsProjectCoordination(
  scope: CommandScopeRequirement,
  policy: HostCommandRuntimePolicy,
): boolean {
  if (policy.bootstrapMode === INSPECTION_ONLY) return false;
  return scope === 'project' || policy.runtimeAccess === 'project-and-user-state';
}

/**
 * Exact root-command pre-scan used to skip Tool discovery. The allowed names
 * come from live decorated host specs rather than a parallel verb allowlist.
 */
export function isInspectionOnlyHostRequest(
  argv: readonly string[],
  hostSpecs: readonly Pick<
    HostRuntimeCommandSpec,
    'name' | 'aliases' | 'scope' | 'hostRuntimePolicy'
  >[],
): boolean {
  let index = 0;
  while (argv[index] === '--no-cloud' || argv[index] === '--no-plugins') index += 1;
  const verb = argv[index];
  if (verb === undefined) return false;
  return hostSpecs.some(
    (spec) =>
      (spec.name === verb || spec.aliases?.includes(verb) === true) &&
      spec.scope === 'none' &&
      resolveHostRuntimePolicy(spec.hostRuntimePolicy).bootstrapMode === INSPECTION_ONLY,
  );
}
