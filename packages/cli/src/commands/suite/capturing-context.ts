import { EXIT_CODES } from '@opensip-cli/contracts';

import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { SignalDeliveryResult, ToolCliContext } from '@opensip-cli/core';

export interface StepCapture {
  readonly exitCodes: readonly number[];
  readonly signalDeliveries: readonly SignalDeliveryResult[];
  readonly context: ToolCliContext;
}

export function createCapturingContext(base: ToolCliContext): StepCapture {
  const exitCodes: number[] = [];
  const signalDeliveries: SignalDeliveryResult[] = [];
  const context = Object.defineProperties(
    {},
    Object.getOwnPropertyDescriptors(base as object),
  ) as ToolCliContext;

  Object.defineProperties(context, {
    setExitCode: {
      value: (code: number) => {
        exitCodes.push(code);
      },
    },
    deliverSignals: {
      value: async (
        envelope: Parameters<ToolCliContext['deliverSignals']>[0],
        opts: Parameters<ToolCliContext['deliverSignals']>[1],
      ) => {
        const result = await base.deliverSignals(envelope, opts);
        signalDeliveries.push(result);
        // Capture the step's findings/gate exit. The host's deliverEnvelope
        // (deliver-envelope.ts / ADR-0035) derives `opts.runFailed ?? !verdict.passed`
        // and applies it through ITS OWN exit writer (closed over at context
        // construction in io-plane.ts), which never routes through this wrapper's
        // setExitCode override — so a NORMAL findings run (runFailed undefined,
        // verdict.passed false) would be invisible to the capture without this
        // mirror. Re-derive the same predicate so a step's verdict participates in
        // the captured step exit (suite worst-of), for both bundled (in-process)
        // and external (worker-RPC-replayed) steps.
        const verdictFailed =
          (envelope as Partial<SignalEnvelope> | undefined)?.verdict?.passed === false;
        if (opts.runFailed ?? verdictFailed) exitCodes.push(EXIT_CODES.RUNTIME_ERROR);
        return result;
      },
    },
  });

  return { exitCodes, signalDeliveries, context };
}
