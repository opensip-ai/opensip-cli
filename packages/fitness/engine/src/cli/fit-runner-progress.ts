import type { ProgressCallback, ProgressEvent } from '@opensip-cli/cli-ui';

export interface CheckCountLabelInput {
  readonly running: number;
  readonly available: number;
  readonly verbose: boolean;
}

export function progressTotal(event: ProgressEvent): number | null {
  return event.type === 'stage-progress' ? event.total : null;
}

export function checkCountLabel({ running, available, verbose }: CheckCountLabelInput): string {
  const runningLabel = `${running} running`;
  if (!verbose) return runningLabel;
  const filtered = Math.max(available - running, 0);
  return `${runningLabel}, ${available} available, ${filtered} filtered`;
}

export function withCheckCountFromProgress(
  subscribe: (cb: ProgressCallback) => void,
  onCheckCount: (checkCount: number) => void,
): (cb: ProgressCallback) => void {
  return (cb) => {
    subscribe((event) => {
      const total = progressTotal(event);
      if (total !== null) {
        onCheckCount(total);
      }
      cb(event);
    });
  };
}
