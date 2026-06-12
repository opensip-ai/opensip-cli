/**
 * api — re-exports forming the CLI's programmatic API surface.
 *
 * Imported and re-exported by `index.ts` so the composition root stays
 * focused on wiring. Tools that depend on `opensip-cli` (a few
 * test harnesses, downstream consumers) import these symbols from the
 * package root; this barrel keeps the surface in one file.
 */

export { EXIT_CODES, getErrorSuggestion } from '@opensip-cli/contracts';
export { buildWelcome, printWelcome } from './welcome.js';
export { buildCompletionScript, printCompletionScript } from './commands/completion.js';
export { executeUninstall } from './commands/uninstall.js';
export { decideOpen, launchBrowser } from './open-dashboard.js';
export { maybeNotify } from './update-notifier.js';
export type {
  SignalEnvelope,
  RunVerdict,
  UnitResult,
  CommandResult,
  FitOptions,
  InitOptions,
  ToolOptions,
} from '@opensip-cli/contracts';
export { resolveApiKey } from './commands/configure.js';
