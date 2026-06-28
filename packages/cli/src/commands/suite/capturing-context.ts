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
        if (opts.runFailed === true) exitCodes.push(1);
        return result;
      },
    },
  });

  return { exitCodes, signalDeliveries, context };
}
