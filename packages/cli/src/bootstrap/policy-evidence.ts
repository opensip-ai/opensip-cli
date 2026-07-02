import { hostEnv } from '../env/host-env-specs.js';

/**
 * Policy evidence preserves the trust-policy plane's original CI predicate:
 * only a literal `CI=true` records CI context. Broader CI sentinel semantics are
 * owned by state-lock policy and should not silently change policy decisions.
 */
export function policyCiEvidenceFromCurrentEnv(): boolean {
  return policyCiEvidenceFromEnvValue(hostEnv.get<string | undefined>('CI'));
}

/** Resolve CI evidence from an injected env bag used by bootstrap tests/workers. */
export function policyCiEvidenceFromEnv(env: NodeJS.ProcessEnv | undefined): boolean {
  return policyCiEvidenceFromEnvValue(env?.CI);
}

function policyCiEvidenceFromEnvValue(value: string | undefined): boolean {
  return value === 'true';
}
