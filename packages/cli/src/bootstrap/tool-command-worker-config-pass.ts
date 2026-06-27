/**
 * tool-command-worker-config-pass — the ADR-0054 M4-E DEEP config validation pass
 * the dispatch worker runs against a tool's OWN config schema.
 *
 * Extracted from `tool-command-worker-entry.ts` to keep that file within the
 * file-length budget. The host coarse pass (pre-fork) validated only the
 * serializable manifest descriptor shape; this is the semantic, authoritative
 * validation the host (which must not import the tool's Zod) could not perform —
 * legitimate HERE, inside the worker isolation boundary, where the runtime is
 * already loaded.
 */

import { resolveToolHooks, type Tool } from '@opensip-cli/core';

/** A Zod-ish schema: the worker checks for `safeParse` structurally (no zod import). */
interface SafeParseable {
  readonly safeParse: (value: unknown) => {
    readonly success: boolean;
    readonly error?: {
      readonly issues?: readonly {
        path?: readonly unknown[];
        message: string;
      }[];
    };
  };
}

/** Structural guard: the loaded tool's config schema exposes a `safeParse` method. */
function isSafeParseable(value: unknown): value is SafeParseable {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function'
  );
}

/**
 * Run the dispatched tool's OWN config schema against its coarse-validated config
 * namespace block.
 *
 * Returns `undefined` on success (or when there is nothing to validate); returns a
 * human-readable `Invalid configuration …` MESSAGE on a schema failure. The caller
 * (the worker entry) wraps the message in a `config-invalid` IPC error message —
 * the worker does NOT throw/crash; the supervisor maps it to the SAME typed config
 * error + exit code the host coarse pass uses (single config-error contract).
 */
export function runDeepConfigPass(tool: Tool, config: unknown): string | undefined {
  // No config block in the document for this tool's namespace → nothing to
  // deep-validate (the host coarse pass already accepted its absence).
  if (config === undefined) return undefined;
  const declaration = resolveToolHooks(tool).config;
  // No Zod declaration on the runtime → defer to the coarse pass's verdict (the
  // host already accepted the block as an opaque object); nothing deeper to run.
  if (declaration === undefined || !isSafeParseable(declaration.schema)) return undefined;

  const result = declaration.schema.safeParse(config);
  if (result.success) return undefined;

  const summary = (result.error?.issues ?? [])
    .map((issue) => {
      const path =
        issue.path !== undefined && issue.path.length > 0
          ? issue.path.join('.')
          : declaration.namespace;
      return `${declaration.namespace}.${path}: ${issue.message}`;
    })
    .join('; ');
  return `Invalid configuration for '${tool.metadata.name ?? tool.metadata.id}': ${
    summary.length > 0 ? summary : 'config did not satisfy the tool schema'
  }`;
}
