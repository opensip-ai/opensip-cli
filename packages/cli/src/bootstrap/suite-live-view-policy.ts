/**
 * Host policy: should `opensip suite run` render through the interactive live
 * view (the per-step checklist), or fall through to a static command-result?
 *
 * The live view mounts Ink and owns the terminal, so it is only appropriate on
 * an interactive TTY and never when the caller asked for machine output
 * (`--json`). Non-TTY / piped / CI / `--json` runs take the static
 * command-result path instead (rendered as plain text by `renderResult`).
 *
 * This predicate lives in the composition root (`bootstrap/**`) — the one layer
 * allowed to probe `process.stdout` — so the suite command handler stays free of
 * direct stdout access and only reaches the terminal through documented
 * `ToolCliContext` seams. It mirrors {@link shouldUseExternalAdapterLiveView}.
 */
export function shouldUseSuiteLiveView(opts: { readonly json: boolean }): boolean {
  if (opts.json) return false;
  return process.stdout.isTTY === true;
}
