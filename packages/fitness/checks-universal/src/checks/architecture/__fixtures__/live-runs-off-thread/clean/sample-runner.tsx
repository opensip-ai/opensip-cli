// CLEAN: a live runner that drives the engine OFF the main process via the
// off-thread selector. No bare in-process transport call.
import { runOffThreadOrInProcess } from '@opensip-cli/core'

export function startLive(args: { cwd: string }): void {
  const run = runOffThreadOrInProcess({
    descriptor: { command: process.argv[1] ?? '', argv: ['fit-run-worker', args.cwd] },
    inProcess: (emit) => execute(args, emit),
  })
  void run.result
}
