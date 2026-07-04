import type { ImpactTrust, SignalEnvelope } from '@opensip-cli/contracts';

class DirectProcessExit extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

function isImpactTrust(value: unknown): value is ImpactTrust {
  const maybe = value as Partial<ImpactTrust> | undefined;
  return (
    maybe !== undefined &&
    (maybe.coverage === 'full' || maybe.coverage === 'partial' || maybe.coverage === 'unknown') &&
    (maybe.fallback === 'targeted' || maybe.fallback === 'full-run') &&
    typeof maybe.fullyVerified === 'boolean' &&
    Array.isArray(maybe.uncertainties)
  );
}

export function verificationFromEnvelope(
  envelope: SignalEnvelope | undefined,
): ImpactTrust | undefined {
  if (envelope === undefined) return undefined;
  if (isImpactTrust(envelope.verification)) return envelope.verification;
  for (const signal of envelope.signals) {
    if (isImpactTrust(signal.metadata.trust)) return signal.metadata.trust;
  }
  return undefined;
}

export async function withProcessExitGuard(
  fn: () => Promise<number>,
  onDirectExit: (code: number) => void,
): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- process.exit has no `this` contract; identity must be restored after the guard.
  const original = process.exit;
  // @fitness-ignore-next-line throws-documentation -- this private guard intentionally throws a sentinel so direct process.exit calls become suite step exit codes.
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number) => {
    throw new DirectProcessExit(typeof code === 'number' ? code : 0);
  };
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DirectProcessExit) {
      onDirectExit(error.code);
      return error.code;
    }
    throw error;
  } finally {
    (process as unknown as { exit: typeof process.exit }).exit = original;
  }
}
