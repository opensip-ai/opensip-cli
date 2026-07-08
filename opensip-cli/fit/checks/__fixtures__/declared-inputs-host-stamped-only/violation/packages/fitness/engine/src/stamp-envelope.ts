import { buildSignalEnvelope } from '@opensip-cli/contracts';

// A tool engine must NOT stamp declaredInputs — this is the host's job (ADR-0097).
export function makeEnvelope() {
  return buildSignalEnvelope({
    tool: 'demo',
    signals: [],
    declaredInputs: { cliVersion: '1.0.0', leaked: process.env.HOME },
  });
}
