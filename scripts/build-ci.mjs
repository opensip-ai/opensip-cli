#!/usr/bin/env node
/**
 * build-ci — workspace build for the CI / release lanes, with a re-sync of
 * pnpm's injected workspace copies in the middle.
 *
 * Why two passes
 * --------------
 * `injectWorkspacePackages: true` (required so the dogfood discovery walker
 * finds the bundled check packs — see scripts/verify-pnpm-injection.mjs)
 * makes pnpm HARD-COPY each first-party workspace dependency into the virtual
 * store at INSTALL time and cache that pack in the global store. The copy is
 * NOT re-synced by a later `pnpm build`. So on a cold checkout / cold store
 * the injected copies are dist-less, and any package that imports a BUILT
 * first-party dep at typecheck time can't resolve it. Concretely:
 * `@opensip-cli/test-support` and the `checks-*` packs import
 * `@opensip-cli/fitness`, and `tsc` fails with
 * `TS2307: Cannot find module '@opensip-cli/fitness'`.
 *
 * (This stayed latent until a dependency edge changed a package's injection
 * hash and missed the warm store-cache pack that previously carried dist.)
 *
 * Pass 1 produces the workspace dist for every package (consumers of a
 * dist-less injected copy fail here on a cold store — tolerated). The
 * re-injection re-packs the injected copies from the freshly-built source;
 * note plain `pnpm install` / `pnpm install --force` short-circuit via the
 * workspace-state cache, so it must be removed first. Pass 2 is the
 * authoritative build: the injected copies now carry dist, so the consumers
 * resolve cleanly.
 *
 * `pnpm build` (single pass) remains the local dev command — a local
 * node_modules already carries built dist in its injected copies.
 */
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

/** Run a binary with a fixed argument vector (no shell). */
function run(file, args, { tolerateFailure = false } = {}) {
  console.log(`\n$ ${file} ${args.join(' ')}`);
  try {
    execFileSync(file, args, { stdio: 'inherit' });
  } catch (error) {
    if (!tolerateFailure) throw error;
    console.log(
      '(non-zero exit tolerated — consumers of a dist-less injected copy fail ' +
        'until the re-injection below; pass 2 is the authoritative gate)',
    );
  }
}

// Pass 1 — produce workspace dist for every package. `--continue` so EVERY
// injected provider builds even though the consumers that resolve a dist-less
// injected copy fail; otherwise turbo would abort before some providers built
// and the re-injection would miss their dist.
run('pnpm', ['exec', 'turbo', 'run', 'build', '--continue'], { tolerateFailure: true });

// Re-pack the injected copies from the freshly-built source. Plain
// `pnpm install` / `--force` short-circuit via this workspace-state cache, so
// remove it first to force the re-pack.
rmSync('node_modules/.pnpm-workspace-state-v1.json', { force: true });
run('pnpm', ['install', '--frozen-lockfile']);

// Pass 2 — authoritative build. Injected copies now carry dist, so every
// consumer resolves; a real error here fails the lane as it should.
run('pnpm', ['exec', 'turbo', 'run', 'build']);
