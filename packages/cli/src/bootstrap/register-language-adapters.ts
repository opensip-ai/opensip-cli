/**
 * register-language-adapters — register the bundled language adapters
 * into a kernel-level `LanguageRegistry`.
 *
 * Extracted from `index.ts` so the registration list is not a
 * module-load side effect but a pure function the composition root
 * calls explicitly. Each adapter ships with a layered language pack
 * (`@opensip-cli/lang-*`); the CLI is the single component that
 * wires them in — fitness/simulation must not take a hard dep on
 * every language pack (would invert the layered architecture).
 *
 * The order below is presentational only; the registry is keyed by
 * adapter id so duplicates short-circuit and order does not affect
 * resolution.
 */

import { cppAdapter } from '@opensip-cli/lang-cpp';
import { goAdapter } from '@opensip-cli/lang-go';
import { javaAdapter } from '@opensip-cli/lang-java';
import { pythonAdapter } from '@opensip-cli/lang-python';
import { rustAdapter } from '@opensip-cli/lang-rust';
import { typescriptAdapter } from '@opensip-cli/lang-typescript';

import type { LanguageRegistry } from '@opensip-cli/core';

/**
 * Register the six bundled language adapters into the supplied
 * registry. Idempotent w.r.t. duplicate registrations: the kernel
 * registry is first-writer-wins.
 */
export function registerLanguageAdapters(registry: LanguageRegistry): void {
  registry.register(typescriptAdapter);
  registry.register(rustAdapter);
  registry.register(pythonAdapter);
  registry.register(javaAdapter);
  registry.register(goAdapter);
  registry.register(cppAdapter);
}
