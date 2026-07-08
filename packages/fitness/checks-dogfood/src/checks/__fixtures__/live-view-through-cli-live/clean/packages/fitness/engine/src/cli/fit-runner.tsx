import { runToolLiveView } from '@opensip-cli/cli-live';

export async function renderFitLive(): Promise<void> {
  await runToolLiveView({} as never, {});
}