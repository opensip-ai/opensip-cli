// `commander` is referenced here purely as a type — `import type` keeps the
// runtime bundle free of any commander require. The package declares `commander`
// as an OPTIONAL peer dependency (see package.json `peerDependencies` +
// `peerDependenciesMeta`) so consumers who want to use `CliProgram` get
// commander surfaced in their dependency graph, while plugins that never touch
// `CliProgram` pay no install cost.
//
// This alias lives in its own module (not the package barrel) so `index.ts`
// stays a PURE re-export barrel — the `import type { Command }` here would
// otherwise disqualify the barrel from the module-coupling-fan-out auto-exempt.
import type { Command } from 'commander';

/**
 * Type alias for Commander's `Command` class — surfaced so the host's
 * command-spec mounting (`mountCommandSpec`) and the tool lifecycle can type the
 * root `program` handle without a direct `commander` import or an `as Command`
 * cast. (Tools themselves no longer touch Commander — they declare
 * `commandSpecs`; the host owns `program`.)
 *
 * `commander` is an OPTIONAL peer dependency of `@opensip-cli/contracts`.
 * `CliProgram` is now primarily a host-side type (the `Tool` contract no longer
 * surfaces it), so any code referencing it needs `commander` resolvable in its
 * own `node_modules`; pnpm/npm will surface the peer requirement in install
 * output. Code that never touches `CliProgram` can skip commander entirely. The
 * alias erases at compile time — no runtime commander require lands in `dist`.
 */
export type CliProgram = Command;
