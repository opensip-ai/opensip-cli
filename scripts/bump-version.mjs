#!/usr/bin/env node
//
// bump-version.mjs — set the opensip-cli product version across every
// HAND-MAINTAINED surface in one atomic command, and verify drift in CI.
//
// Source of truth: packages/core/package.json#version. Everything else is
// either bumped here or DERIVED from it (and regenerated separately).
//
// Usage:
//   node scripts/bump-version.mjs <new-version> [--date YYYY-MM-DD]
//   node scripts/bump-version.mjs --check          # assert all surfaces match core
//
// After a bump, regenerate the DERIVED surfaces (they read core's version):
//   pnpm docs:readmes        # 33 package READMEs (version-pinned GitHub links)
//   pnpm docs:build          # docs/web-generated/** (blob/vX.Y.Z links + manifest)
//
// What this script OWNS (deterministic — automated here):
//   1. Version fields  — every publishable @opensip-cli/* + the unscoped
//      `opensip-cli` + the private @opensip-cli/root + @opensip-cli/test-support
//      (35 package.json). Fixture scopes (@fixture/*, @example/*, @medium/*,
//      @opensip-cli-fixture/*, bare names) are skipped — they assert fixed
//      versions as test data.
//   2. Doc frontmatter — `release: v<old>` → `release: v<new>` across
//      docs/public/**/*.md (INCLUDING the top-level README.md).
//   3. Scope-qualified peer-dep ranges in docs — `"@opensip-cli/x": "^<old>"`
//      and `"opensip-cli": "^<old>"` → `^<new>`. (Example plugins' OWN
//      `"version"` fields are NOT touched — they version independently.)
//   4. SECURITY.md supported-release table row.
//   5. Curated prose version tokens (verified-at markers, the package-catalog
//      "all at" line, the install-script env example, the website-integration
//      manifest example, the graph cacheKey example, the CLAUDE status line,
//      the tool-plugin-model install pin).
//
// What this script does NOT own (judgment — printed as a checklist):
//   - CHANGELOG.md narrative entry (`## [<new>] - <date>` + release notes).
//   - One-time conceptual prose when crossing the 1.0 boundary (e.g. the
//     "pin to 0.x line" vs "pin to majors" peer-dependency guidance).
//   - The DERIVED surfaces above (run the two pnpm commands).
//
// See RELEASING.md → "Version Surfaces (what a bump touches)" and ADR-0012.

import { promises as fs } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCOPE = '@opensip-cli/';
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// ---------------------------------------------------------------------
// args
// ---------------------------------------------------------------------
const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const dateIdx = argv.indexOf('--date');
const dateArg = dateIdx === -1 ? null : argv[dateIdx + 1];
const positional = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--date');
const newVersion = checkOnly ? null : positional;

if (!checkOnly) {
  if (!newVersion || !SEMVER.test(newVersion)) {
    fail(
      `usage: node scripts/bump-version.mjs <new-version> [--date YYYY-MM-DD]\n` +
        `   or: node scripts/bump-version.mjs --check\n` +
        (newVersion
          ? `\n'${newVersion}' is not a valid semver (e.g. 0.1.0, 1.2.3, 0.2.0-rc.1).`
          : ''),
    );
  }
  if (dateArg && !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
    fail(`--date must be ISO YYYY-MM-DD (got '${dateArg}').`);
  }
}
const releaseDate = dateArg ?? new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------
function fail(msg) {
  console.error(`[bump-version] ${msg}`);
  process.exit(2);
}
const rel = (p) => relative(REPO_ROOT, p);

async function readText(p) {
  return fs.readFile(p, 'utf8');
}
async function writeText(p, t) {
  await fs.writeFile(p, t);
}
async function walk(dir, pred) {
  const out = [];
  const recur = async (d) => {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
      const full = join(d, e.name);
      if (e.isDirectory()) await recur(full);
      else if (e.isFile() && pred(full)) out.push(full);
    }
  };
  await recur(dir);
  return out;
}

// Publishable/owned package.json: name is `opensip-cli`, `@opensip-cli/root`,
// or starts with `@opensip-cli/`. Excludes @opensip-cli-fixture/* (no slash).
function isOwnedPkgName(name) {
  return (
    name === 'opensip-cli' ||
    name === '@opensip-cli/root' ||
    (typeof name === 'string' && name.startsWith(SCOPE))
  );
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------
// surface readers (used by both bump and --check)
// ---------------------------------------------------------------------
async function ownedPackageJsons() {
  const files = await walk(join(REPO_ROOT, 'packages'), (p) => p.endsWith('package.json'));
  files.push(join(REPO_ROOT, 'package.json'));
  const out = [];
  for (const f of files) {
    let pkg;
    try {
      pkg = JSON.parse(await readText(f));
    } catch {
      continue;
    }
    if (isOwnedPkgName(pkg.name)) out.push({ file: f, pkg, raw: pkg.version });
  }
  return out;
}

async function coreVersion() {
  const pkg = JSON.parse(await readText(join(REPO_ROOT, 'packages/core/package.json')));
  return pkg.version;
}

async function publicDocs() {
  return walk(join(REPO_ROOT, 'docs/public'), (p) => p.endsWith('.md'));
}

// Curated prose anchors, version-templated. Each is a pure version-token swap
// in a specific file — none collide with example plugins' own "version" lines.
function curatedProse(old, next) {
  return [
    ['CLAUDE.md', [[`**v${old} (`, `**v${next} (`]]],
    [
      'docs/public/README.md',
      [
        [`opensip-cli v${old}:`, `opensip-cli v${next}:`],
        [`This v${old} doc set`, `This v${next} doc set`],
      ],
    ],
    [
      'docs/public/70-reference/02-package-catalog.md',
      [
        [`Last verified at v${old}`, `Last verified at v${next}`],
        ['(all at `' + old + '`)', '(all at `' + next + '`)'],
      ],
    ],
    [
      'docs/public/80-implementation/06-doc-conventions.md',
      [[`Last verified at v${old}`, `Last verified at v${next}`]],
    ],
    [
      'docs/public/70-reference/08-supply-chain-security.md',
      [[`OPENSIP_CLI_VERSION=${old}`, `OPENSIP_CLI_VERSION=${next}`]],
    ],
    [
      'docs/public/80-implementation/07-website-integration.md',
      [
        [`e.g. "${old}"`, `e.g. "${next}"`],
        [`/v${old}/`, `/v${next}/`],
      ],
    ],
    ['docs/public/40-graph/01-stages-and-catalog.md', [[`eng=${old}`, `eng=${next}`]]],
    [
      'docs/public/10-concepts/02-tool-plugin-model.md',
      [[`opensip-cli@${old}`, `opensip-cli@${next}`]],
    ],
  ].map(([f, pairs]) => ({
    file: join(REPO_ROOT, f),
    pairs: pairs.map(([from, to]) => ({ from, to })),
  }));
}

const depRangeRe = (old) =>
  new RegExp(`("(?:@opensip-cli/[a-z0-9-]+|opensip-cli)":\\s*")\\^${esc(old)}(")`, 'g');

const securityRowRe = (ver) => new RegExp(`^(\\|\\s*)${esc(ver)}(\\s*\\|\\s*Yes\\s*\\|)\\s*$`, 'm');

// ---------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------
async function runCheck() {
  const core = await coreVersion();
  const problems = [];

  const pkgs = await ownedPackageJsons();
  for (const { file, raw } of pkgs) {
    if (raw !== core) problems.push(`${rel(file)}: version ${raw} ≠ core ${core}`);
  }

  for (const f of await publicDocs()) {
    const t = await readText(f);
    const m = t.match(/^release: v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/m);
    if (m && m[1] !== core)
      problems.push(`${rel(f)}: frontmatter release v${m[1]} ≠ core v${core}`);
    let dm;
    // detect any scope-qualified caret range whose version ≠ core
    const anyDep = /"(?:@opensip-cli\/[a-z0-9-]+|opensip-cli)":\s*"\^(\d+\.\d+\.\d+)"/g;
    while ((dm = anyDep.exec(t)) !== null) {
      if (dm[1] !== core) problems.push(`${rel(f)}: peer-dep ^${dm[1]} ≠ core ^${core}`);
    }
  }

  const sec = await readText(join(REPO_ROOT, 'SECURITY.md'));
  if (!securityRowRe(core).test(sec)) {
    problems.push(`SECURITY.md: supported-release table has no row for ${core}`);
  }

  const changelog = await readText(join(REPO_ROOT, 'CHANGELOG.md'));
  const topEntry = changelog.match(/^##\s*\[([^\]]+)\]/m);
  if (!topEntry) problems.push(`CHANGELOG.md: no '## [version]' entry found`);
  else if (topEntry[1] !== core)
    problems.push(`CHANGELOG.md: top entry [${topEntry[1]}] ≠ core ${core}`);

  if (problems.length === 0) {
    console.log(`[bump-version] OK — all version surfaces match core v${core}.`);
    return;
  }
  console.error(
    `[bump-version] DRIFT — ${problems.length} surface(s) disagree with core v${core}:`,
  );
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

// ---------------------------------------------------------------------
// bump
// ---------------------------------------------------------------------
async function runBump() {
  const old = await coreVersion();
  if (old === newVersion) {
    console.log(
      `[bump-version] core already at ${newVersion}; re-applying to all surfaces for consistency.`,
    );
  }

  // 1. version fields
  const pkgs = await ownedPackageJsons();
  let bumped = 0;
  for (const { file, pkg } of pkgs) {
    if (pkg.version !== newVersion) {
      pkg.version = newVersion;
      await writeText(file, JSON.stringify(pkg, null, 2) + '\n');
      bumped++;
    }
  }
  console.log(
    `[bump-version] package.json: set ${bumped}/${pkgs.length} owned packages to ${newVersion}`,
  );

  // 2 + 3. doc frontmatter + scope-qualified dep ranges
  let fm = 0,
    deps = 0;
  for (const f of await publicDocs()) {
    let t = await readText(f);
    const orig = t;
    t = t.replace(new RegExp(`^release: v${esc(old)}$`, 'm'), `release: v${newVersion}`);
    t = t.replace(depRangeRe(old), (_m, a, b) => {
      deps++;
      return `${a}^${newVersion}${b}`;
    });
    if (t !== orig) {
      if (new RegExp(`^release: v${esc(old)}$`, 'm').test(orig)) fm++;
      await writeText(f, t);
    }
  }
  console.log(
    `[bump-version] docs/public: ${fm} frontmatter markers, ${deps} peer-dep ranges → ${newVersion}`,
  );

  // 4. SECURITY.md table row
  {
    const p = join(REPO_ROOT, 'SECURITY.md');
    const t = await readText(p);
    if (securityRowRe(old).test(t)) {
      await writeText(p, t.replace(securityRowRe(old), `$1${newVersion}$2`));
      console.log(`[bump-version] SECURITY.md: supported-release row ${old} → ${newVersion}`);
    } else {
      console.log(`[bump-version] SECURITY.md: no '${old}' supported row found — review manually`);
    }
  }

  // 5. curated prose
  let prose = 0;
  for (const { file, pairs } of curatedProse(old, newVersion)) {
    let t;
    try {
      t = await readText(file);
    } catch {
      continue;
    }
    const orig = t;
    for (const { from, to } of pairs) t = t.split(from).join(to);
    if (t !== orig) {
      await writeText(file, t);
      prose++;
    }
  }
  console.log(`[bump-version] curated prose: updated ${prose} file(s)`);

  // checklist
  console.log('\n[bump-version] DONE. Remaining (judgment — do by hand):');
  console.log(`  1. CHANGELOG.md — add a top entry:  ## [${newVersion}] - ${releaseDate}`);
  const changelogText = await readText(join(REPO_ROOT, 'CHANGELOG.md'));
  const top = changelogText.match(/^##\s*\[[^\]]+\][^\n]*/m);
  console.log(`       current top: ${top ? top[0] : '(none)'}`);
  console.log('  2. Regenerate derived surfaces:     pnpm docs:readmes && pnpm docs:build');
  console.log('  3. If crossing the 1.0 boundary, review peer-dep GUIDANCE prose');
  console.log('     ("pin to 0.x line" vs "pin to majors") in docs/public/10-concepts.');
  console.log('  4. Verify:                          node scripts/bump-version.mjs --check');
  console.log(
    '  5. Then:                            pnpm verify-release --expected-version v' + newVersion,
  );
}

await (checkOnly ? runCheck() : runBump());
