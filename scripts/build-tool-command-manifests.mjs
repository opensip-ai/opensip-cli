#!/usr/bin/env node
/**
 * build-tool-command-manifests — derive and write each BUNDLED tool's serializable
 * command SHELL into its `package.json#opensipTools.commands` (ADR-0054 M4-G).
 *
 * Why: after the M4-G capstone the host mounts an EXTERNAL tool's command shells
 * from the static manifest ALONE (no runtime import) via `synthesizeExternalTool`.
 * The platform's GA acceptance bar (`fit-acceptance-e2e`) presents the BUNDLED
 * fitness package AS an installed tool and asserts byte-identical `--help` + run
 * behaviour vs the bundled path. That only holds if the bundled manifest carries
 * the FULL command shell — `name`, `description`, `aliases`, `visibility`,
 * `parent`, `commonFlags`, `options` (minus the non-serializable `parse` closure),
 * `args`, `scope`, `output`, `rawStreamReason` — not just `{name, description}`.
 *
 * Hand-maintaining ~17 command shells (fit/sim/graph) across three package.json
 * files would rot. So the shell is DERIVED from each tool's runtime
 * `commandSpecs` (the single source of truth the host mounts from in the bundled
 * path) and written back; the `--check` gate fails CI on any drift, so the
 * manifest can never silently fall out of sync with the runtime spec.
 *
 * The ONE field deliberately NOT carried is `OptionSpec.parse` — a runtime
 * coercion closure that cannot be serialized (ADR-0054 M4-G `ManifestOptionDescriptor`).
 * An external command mounts its options WITHOUT the parse reducer; the worker
 * (which holds the real spec) coerces in its handler. Documented narrowing.
 *
 * Requires the bundled tool packages to be BUILT (`dist/index.js`) — it imports
 * each tool's `commandSpecs`. Run after `pnpm build`.
 *
 * Usage:
 *   node scripts/build-tool-command-manifests.mjs           # write commands[]
 *   node scripts/build-tool-command-manifests.mjs --check    # exit 1 on drift
 *
 * Mirrors build-package-keywords.mjs (sibling generator + gate).
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHECK_ONLY = process.argv.slice(2).includes('--check');
const BUNDLED_TOOLS_MANIFEST_PATH = join(
  REPO_ROOT,
  'packages',
  'cli',
  'src',
  'bootstrap',
  'bundled-tools.manifest.json',
);

const log = (msg) => console.error(`[build-tool-command-manifests] ${msg}`);

/**
 * The substrate's manifest-derivation helpers, loaded from its built dist. The
 * adapter `requires` (network→resource forward-map, ADR-0092 §4.8) and the coarse
 * `config` descriptor (the namespace claim, ADR-0090 §4.3) are DERIVED from the
 * runtime Tool here so they can never drift from the spec — single-sourced in the
 * substrate, exactly as the command shells are. Loaded lazily (only when an adapter
 * dir is processed) so the bundled-only run does not require the substrate dist.
 */
let adapterManifestHelpers;
async function loadAdapterManifestHelpers() {
  if (adapterManifestHelpers !== undefined) return adapterManifestHelpers;
  const entry = join(REPO_ROOT, 'packages', 'external-tool-adapter', 'dist', 'index.js');
  if (!existsSync(entry)) {
    log(`MISSING build artifact: ${relative(REPO_ROOT, entry)} — run \`pnpm build\` first`);
    process.exit(1);
  }
  const mod = await import(pathToFileURL(entry).href);
  adapterManifestHelpers = {
    deriveAdapterManifestRequires: mod.deriveAdapterManifestRequires,
    deriveAdapterConfigManifest: mod.deriveAdapterConfigManifest,
  };
  return adapterManifestHelpers;
}

function workspacePackageDirs() {
  const packagesDir = join(REPO_ROOT, 'packages');
  const dirs = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const topLevel = join(packagesDir, entry.name);
    if (existsSync(join(topLevel, 'package.json'))) dirs.push(topLevel);
    for (const child of readdirSync(topLevel, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const nested = join(topLevel, child.name);
      if (existsSync(join(nested, 'package.json'))) dirs.push(nested);
    }
  }
  return dirs;
}

function workspacePackageDirByName() {
  const byName = new Map();
  for (const dir of workspacePackageDirs()) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (typeof pkg.name === 'string') byName.set(pkg.name, relative(REPO_ROOT, dir));
  }
  return byName;
}

/**
 * The bundled tool packages whose manifests carry a derived command shell. The
 * list is derived from the same manifest the CLI bootstrap uses so a newly
 * bundled tool cannot silently miss command-shell generation.
 */
function bundledToolDirs() {
  const manifest = JSON.parse(readFileSync(BUNDLED_TOOLS_MANIFEST_PATH, 'utf8'));
  const packages = manifest.bundledPackages;
  if (!Array.isArray(packages)) {
    log('bundled-tools.manifest.json must declare bundledPackages[]');
    process.exit(1);
  }
  const byName = workspacePackageDirByName();
  return packages.map((packageName) => {
    if (typeof packageName !== 'string') {
      log('bundled-tools.manifest.json bundledPackages[] entries must be strings');
      process.exit(1);
    }
    const dir = byName.get(packageName);
    if (dir === undefined) {
      log(`bundled tool package ${packageName} has no workspace package.json`);
      process.exit(1);
    }
    return dir;
  });
}

const BUNDLED_TOOL_DIRS = bundledToolDirs();

/**
 * External Tool Adapter packages (ADR-0090, Phase-0 decision 7). These are
 * OPT-IN / installed (NOT in `bundled-tools.manifest.json`), but they mount from
 * the SAME static-manifest path bundled tools use — so `assertCommandNamesMatch`
 * throws on drift at install + worker import. There is no other generator for
 * them, so the command-shell parity gate (scan + auto-added doctor/version) lives
 * here too: the adapter's runtime `commandSpecs` are the single source, and the
 * `--check` lane fails CI on drift. The substrate's `deriveAdapterManifestCommands`
 * produces the identical shape from the same `commandSpecs`; `deriveCommandShell`
 * below is the generator-local equivalent already used for bundled tools.
 */
const ADAPTER_TOOL_DIRS = [
  'packages/tool-gitleaks',
  'packages/tool-osv-scanner',
  'packages/tool-trivy',
];

/** Every tool dir whose static manifest carries a generated command shell. */
const TOOL_DIRS = [...BUNDLED_TOOL_DIRS, ...ADAPTER_TOOL_DIRS];

/**
 * Derive the serializable command SHELL from a runtime `CommandSpec`. Mirrors the
 * fields `ToolCommandManifest` carries (ADR-0054 M4-G) — everything `mountCommandSpec`
 * reads EXCEPT the `handler` fn and each option's non-serializable `parse` closure.
 * Optional fields are omitted when absent so the manifest stays minimal and the
 * loader's runtime defaults apply on read.
 */
function deriveCommandShell(spec) {
  const shell = { name: spec.name, description: spec.description };
  if (spec.aliases !== undefined) shell.aliases = [...spec.aliases];
  if (spec.visibility !== undefined) shell.visibility = spec.visibility;
  if (spec.parent !== undefined) shell.parent = spec.parent;
  // commonFlags is required on a runtime spec; carry it verbatim (may be []).
  shell.commonFlags = [...(spec.commonFlags ?? [])];
  if (spec.options !== undefined)
    shell.options = spec.options.map((o) => deriveOptionDescriptor(o));
  if (spec.args !== undefined) shell.args = spec.args.map((a) => ({ ...a }));
  // scope/output are required on a runtime spec; carry them so the host mount
  // is byte-identical (rather than relying on the loader default).
  shell.scope = spec.scope;
  shell.output = spec.output;
  if (spec.rawStreamReason !== undefined) shell.rawStreamReason = spec.rawStreamReason;
  // Carry the verdict-capability so the host (which synthesizes external tools
  // from the manifest, no runtime import) knows a scan command is suite-eligible.
  if (spec.producesVerdict !== undefined) shell.producesVerdict = spec.producesVerdict;
  return shell;
}

/** OptionSpec → ManifestOptionDescriptor: every field except the `parse` closure. */
function deriveOptionDescriptor(option) {
  const serializable = { ...option };
  delete serializable.parse;
  // Drop runtime-environment-derived defaults (e.g. the common `--cwd` flag's
  // `default: process.cwd()`): an absolute filesystem path resolved at generation
  // time is machine/worktree-specific and would make this manifest — and its
  // `--check` drift gate — non-deterministic across machines/CI. The runtime
  // resolves these lazily at parse time (`opts.cwd ?? process.cwd()`), so omitting
  // the baked path is behaviour-preserving.
  if (typeof serializable.default === 'string' && isAbsolute(serializable.default)) {
    delete serializable.default;
  }
  return serializable;
}

async function loadBundledTool(toolDir) {
  const entry = join(REPO_ROOT, toolDir, 'dist', 'index.js');
  if (!existsSync(entry)) {
    log(`MISSING build artifact: ${relative(REPO_ROOT, entry)} — run \`pnpm build\` first`);
    process.exit(1);
  }
  const mod = await import(pathToFileURL(entry).href);
  const tool = mod.tool;
  if (tool === undefined || !Array.isArray(tool.commandSpecs)) {
    log(`tool package ${toolDir} does not export a \`tool\` with commandSpecs[]`);
    process.exit(1);
  }
  return tool;
}

async function main() {
  const drift = [];
  let written = 0;

  for (const toolDir of TOOL_DIRS) {
    const pjPath = join(REPO_ROOT, toolDir, 'package.json');
    const raw = readFileSync(pjPath, 'utf8');
    const pkg = JSON.parse(raw);
    if (pkg.opensipTools === undefined) {
      log(`${toolDir}/package.json has no opensipTools manifest — skipping`);
      continue;
    }

    const tool = await loadBundledTool(toolDir);
    pkg.opensipTools.commands = tool.commandSpecs.map((spec) => deriveCommandShell(spec));

    // ADR-0092 §4.8 / ADR-0090 §4.3: for an adapter, ALSO derive `requires` (from
    // the network posture) and `config` (the coarse namespace claim). Both are
    // single-sourced in the substrate so the static manifest can never drift from
    // the runtime; the `--check` lane fails CI on a derivation mismatch.
    if (ADAPTER_TOOL_DIRS.includes(toolDir)) {
      const { deriveAdapterManifestRequires, deriveAdapterConfigManifest } =
        await loadAdapterManifestHelpers();
      pkg.opensipTools.requires = deriveAdapterManifestRequires(tool);
      const config = deriveAdapterConfigManifest(tool);
      if (config === undefined) {
        delete pkg.opensipTools.config;
      } else {
        pkg.opensipTools.config = config;
      }
    }
    // ADR-0054 M4-G: carry the serializable pluginLayout (`{ domain, userSubdirs }`)
    // so a pack-supporting tool loaded via the external path synthesizes the same
    // `<tool> plugin …` group + init scaffolding. A tool with no layout (e.g. graph)
    // omits it.
    if (tool.pluginLayout === undefined) {
      delete pkg.opensipTools.pluginLayout;
    } else {
      pkg.opensipTools.pluginLayout = {
        domain: tool.pluginLayout.domain,
        userSubdirs: [...tool.pluginLayout.userSubdirs],
      };
    }
    const serialized = `${JSON.stringify(pkg, null, 2)}\n`;

    if (serialized === raw) continue;

    if (CHECK_ONLY) {
      drift.push(relative(REPO_ROOT, pjPath));
    } else {
      writeFileSync(pjPath, serialized, 'utf8');
      written++;
    }
  }

  if (CHECK_ONLY) {
    if (drift.length === 0) {
      log(
        `all ${TOOL_DIRS.length} tool manifest(s) (bundled + adapter) carry the current command shell.`,
      );
      return;
    }
    log(
      `${drift.length} bundled tool manifest(s) drifted from the runtime command shell — ` +
        `run \`pnpm tool-manifests\`:`,
    );
    for (const f of drift) log(`  - ${f}`);
    process.exit(1);
  }

  log(
    `considered ${TOOL_DIRS.length} tool(s) (bundled + adapter); updated command shell on ${written}.`,
  );
}

await main();
