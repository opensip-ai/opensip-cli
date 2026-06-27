import { applyAgentFilters } from '@opensip-cli/contracts';

export function filterEnvelope(envelope: Parameters<typeof applyAgentFilters>[0], filters: string[]) {
  return applyAgentFilters(envelope, filters);
}