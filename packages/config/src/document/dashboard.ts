/**
 * dashboard — the `dashboard:` document-level block of
 * `opensip-cli.config.yml`.
 *
 * Currently just the editor protocol used by the Code Paths panel to build
 * `vscode://` / `cursor://` deep links. `dashboard` is a CLI-owned
 * composition-root command, not a Tool plugin (ADR-0023 §Amendment), so its
 * config is a host document-level block — structurally identical to `cli`,
 * registered beside it in {@link ./host-declarations}.
 *
 * Relocated here in 2.10.1 from fitness's `SignalersConfigSchema`. Fitness
 * still reads `dashboard.editor` via `loadSignalersConfig` until it is repointed
 * to the composed scope config (Phase 4); it imports this schema rather than
 * re-defining it, so there is one definition of the block.
 */

import { z } from 'zod';

/** The Zod schema for the `dashboard:` document-level block. */
export const dashboardConfigSchema = z.object({
  editor: z.string().min(1).max(64).optional(),
});
