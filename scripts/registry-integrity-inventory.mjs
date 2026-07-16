#!/usr/bin/env node
/**
 * Build or independently verify the canonical exact-npm registry integrity
 * inventory used by the macOS release qualification gate.
 *
 * This is a repository/release utility, not a customer-facing `opensip`
 * command. Its argv grammar is closed and every successful invocation prints
 * exactly one lowercase SHA-256 inventory digest.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildRegistryIntegrityInventory,
  canonicalRegistry,
  registryIntegrityDigest,
  renderRegistryIntegrityInventory,
  verifyRegistryIntegrityInventory,
} from './lib/registry-integrity-inventory.mjs';
import { readBoundedFileBytes } from './platform-acceptance/bounded-owned-file.mjs';
import { resolveNpmInvocation } from './platform-acceptance/node-cli-invocation.mjs';

const COMMANDS = new Set(['build', 'verify']);
const BUILD_FLAGS = new Set([
  '--directory',
  '--manifest',
  '--version',
  '--registry',
  '--expected-manifest-digest',
  '--out',
]);
const VERIFY_FLAGS = new Set([
  '--inventory',
  '--manifest',
  '--expected-version',
  '--expected-registry',
  '--expected-manifest-digest',
  '--expected-digest',
]);
const HEX64 = /^[a-f0-9]{64}$/u;
const MAX_NPM_VIEW_BYTES = 64 * 1024;
const NPM_VIEW_TIMEOUT_MS = 30_000;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_INVENTORY_BYTES = 8 * 1024 * 1024;

const HELP = `registry-integrity-inventory — exact npm release provenance

Usage:
  node scripts/registry-integrity-inventory.mjs build \\
    --directory <registry-tarballs> --manifest <release-manifest> \\
    --version <exact-semver> --registry <https-url> \\
    --expected-manifest-digest <sha256> --out <absolute-path>

  node scripts/registry-integrity-inventory.mjs verify \\
    --inventory <path> --manifest <release-manifest> \\
    --expected-version <exact-semver> --expected-registry <https-url> \\
    --expected-manifest-digest <sha256> --expected-digest <sha256>

Success prints exactly one lowercase SHA-256 inventory digest.`;

function hasControlChars(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function invalid(message) {
  return { ok: false, message };
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const [command, ...tokens] = argv;
  if (!COMMANDS.has(command)) return invalid('expected build or verify');
  const allowed = command === 'build' ? BUILD_FLAGS : VERIFY_FLAGS;
  const flags = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const flag = tokens[index];
    if (!allowed.has(flag)) return invalid(`unknown ${command} flag ${String(flag)}`);
    if (flags[flag] !== undefined) return invalid(`duplicate flag ${flag}`);
    const value = tokens[index + 1];
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.startsWith('--') ||
      hasControlChars(value)
    ) {
      return invalid(`flag ${flag} requires a valid value`);
    }
    flags[flag] = value;
    index += 1;
  }
  for (const flag of allowed) {
    if (flags[flag] === undefined) return invalid(`${flag} is required for ${command}`);
  }
  for (const flag of ['--expected-manifest-digest', '--expected-digest']) {
    if (flags[flag] !== undefined && !HEX64.test(flags[flag])) {
      return invalid(`${flag} must be a 64-character lowercase SHA-256 digest`);
    }
  }
  if (command === 'build' && !isAbsolute(flags['--out'])) {
    return invalid('--out must be an absolute path');
  }
  return { ok: true, command, flags };
}

function readNpmMetadata({ name, version, registry }, npmInvocation) {
  const result = spawnSync(
    npmInvocation.command,
    [
      ...npmInvocation.prefixArgs,
      'view',
      `${name}@${version}`,
      'version',
      'dist.integrity',
      'dist.tarball',
      '--json',
      '--registry',
      registry,
    ],
    {
      encoding: 'utf8',
      maxBuffer: MAX_NPM_VIEW_BYTES,
      shell: false,
      timeout: NPM_VIEW_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    throw new Error(`exact registry metadata unavailable for ${name}`);
  }
  let raw;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    throw new Error(`registry metadata was malformed for ${name}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`registry metadata was malformed for ${name}`);
  }
  return {
    version: raw.version,
    integrity: raw['dist.integrity'],
    tarballUrl: raw['dist.tarball'],
  };
}

function readBounded(path, maxBytes, label) {
  const result = readBoundedFileBytes({
    path,
    maxBytes,
    reasonPrefix: label,
    requireNonEmpty: true,
  });
  if (!result.ok) throw new TypeError(`${label} could not be read safely (${result.reasonCode})`);
  return result.buffer;
}

function writeAtomic(path, text) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function build(flags) {
  const registry = canonicalRegistry(flags['--registry']);
  const npmInvocation = resolveNpmInvocation();
  const inventory = await buildRegistryIntegrityInventory({
    artifactDir: flags['--directory'],
    manifestBytes: readBounded(flags['--manifest'], MAX_MANIFEST_BYTES, 'release-manifest'),
    version: flags['--version'],
    registry,
    expectedManifestDigest: flags['--expected-manifest-digest'],
    metadataForPackage: (input) => readNpmMetadata(input, npmInvocation),
  });
  const rendered = renderRegistryIntegrityInventory(inventory);
  writeAtomic(flags['--out'], rendered);
  return registryIntegrityDigest(inventory);
}

function verify(flags) {
  return verifyRegistryIntegrityInventory({
    inventoryBytes: readBounded(
      flags['--inventory'],
      MAX_INVENTORY_BYTES,
      'registry-integrity-inventory',
    ),
    manifestBytes: readBounded(flags['--manifest'], MAX_MANIFEST_BYTES, 'release-manifest'),
    expectedVersion: flags['--expected-version'],
    expectedRegistry: flags['--expected-registry'],
    expectedManifestDigest: flags['--expected-manifest-digest'],
    expectedDigest: flags['--expected-digest'],
  }).digest;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (!parsed.ok) {
    process.stderr.write(`registry-integrity-inventory: ${parsed.message}\n`);
    return 2;
  }
  try {
    const digest = parsed.command === 'build' ? await build(parsed.flags) : verify(parsed.flags);
    process.stdout.write(`${digest}\n`);
    return 0;
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error';
    process.stderr.write(`registry-integrity-inventory: verification failed (${name})\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write('registry-integrity-inventory: unexpected failure\n');
      process.exitCode = 1;
    },
  );
}
