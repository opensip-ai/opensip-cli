#!/usr/bin/env node
//
// sync-package-licenses.mjs — ensure every PUBLISHABLE package ships the root
// LICENSE + NOTICE in its npm tarball, and declares them in `files`.
//
// Why this exists: npm auto-includes a top-level LICENSE in a tarball, but only
// from the package's OWN directory — the monorepo root LICENSE is never copied
// into each package. NOTICE is never auto-included at all. Under Apache-2.0
// (§4(d): redistributions must carry the NOTICE), each published package should
// ship both. So we copy LICENSE + NOTICE from the repo root into each
// publishable package dir and add them to that package.json's `files`
// allowlist. The copies are committed (so reviewers see them and `pnpm pack`
// ships them), mirroring how generated READMEs are handled.
//
// Single source of truth for the publishable set: discoverPublishablePackages()
// from release-package-order.mjs (name is `opensip-cli` or `@opensip-cli/*`, and
// NOT private). The private root + @opensip-cli/test-support are never
// published, so they are skipped.
//
// Usage:
//   node scripts/sync-package-licenses.mjs           # write/refresh files + allowlist
//   node scripts/sync-package-licenses.mjs --check    # assert in sync (CI; non-zero on drift)

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverPublishablePackages } from './release-package-order.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LICENSE_FILES = ['LICENSE', 'NOTICE'];
const checkOnly = process.argv.includes('--check');

const read = (p) => fs.readFile(p, 'utf8');

async function main() {
  // Canonical content lives at the repo root.
  const root = {};
  for (const f of LICENSE_FILES) {
    try {
      root[f] = await read(join(REPO_ROOT, f));
    } catch {
      console.error(`[sync-package-licenses] missing root ${f} — nothing to sync.`);
      process.exit(2);
    }
  }

  const pkgs = await discoverPublishablePackages(REPO_ROOT); // { name, dir }[]
  const problems = [];
  let wroteFiles = 0;
  let wroteJson = 0;

  for (const { dir } of pkgs) {
    const pkgDir = join(REPO_ROOT, dir);

    // 1. The LICENSE + NOTICE files themselves, byte-identical to root.
    for (const f of LICENSE_FILES) {
      const dst = join(pkgDir, f);
      let cur = null;
      try {
        cur = await read(dst);
      } catch {
        /* missing */
      }
      if (cur !== root[f]) {
        if (checkOnly)
          problems.push(`${dir}/${f}: ${cur === null ? 'missing' : 'differs from root'}`);
        else {
          await fs.writeFile(dst, root[f]);
          wroteFiles++;
        }
      }
    }

    // 2. The `files` allowlist must declare both (npm always ships LICENSE, but
    //    declaring it is explicit; NOTICE is NOT auto-included, so it MUST be
    //    listed or it won't reach the tarball).
    const pkgPath = join(pkgDir, 'package.json');
    const pkg = JSON.parse(await read(pkgPath));
    const files = Array.isArray(pkg.files) ? pkg.files : [];
    const missing = LICENSE_FILES.filter((f) => !files.includes(f));
    if (missing.length > 0) {
      if (checkOnly) problems.push(`${dir}/package.json: files[] missing ${missing.join(', ')}`);
      else {
        pkg.files = [...files, ...missing];
        await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
        wroteJson++;
      }
    }
  }

  if (checkOnly) {
    if (problems.length === 0) {
      console.log(
        `[sync-package-licenses] OK — all ${pkgs.length} publishable packages carry LICENSE + NOTICE and declare them in files[].`,
      );
      return;
    }
    console.error(
      `[sync-package-licenses] ${problems.length} issue(s) — run \`pnpm licenses:sync\`:`,
    );
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log(
    `[sync-package-licenses] ${pkgs.length} publishable packages: wrote ${wroteFiles} license file(s), updated ${wroteJson} package.json files[].`,
  );
}

await main();
