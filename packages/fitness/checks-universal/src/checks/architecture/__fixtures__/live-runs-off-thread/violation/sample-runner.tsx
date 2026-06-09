// VIOLATION: a live runner that drives the engine through the BARE in-process
// transport — the engine runs on the render thread and the spinner starves.
import { createInProcessTransport } from '@opensip-tools/core'

export function startLive(args: { cwd: string }): void {
  const run = createInProcessTransport().run((emit) => execute(args, emit))
  void run.result
}
