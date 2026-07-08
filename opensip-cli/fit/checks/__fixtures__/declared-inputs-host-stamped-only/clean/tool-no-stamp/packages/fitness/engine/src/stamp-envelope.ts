import { buildSignalEnvelope } from '@opensip-cli/contracts';

export function makeEnvelope() {
  return buildSignalEnvelope({ tool: 'demo', signals: [] });
}
