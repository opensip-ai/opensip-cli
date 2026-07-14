# Distribution Footprint Measurement

`pnpm distribution:measure` is repository decision tooling for measuring the
current packed OpenSIP CLI. It is not a customer command, release installer, or
distribution format. The authoritative output is a caller-owned schema-v1 JSON
report; progress lines on stderr are intentionally not a machine contract.

## Build the complete release input

Use a clean, built checkout whose publishable package versions match. Produce
every tarball named by the canonical release order; a partial or extra set is a
hard failure.

```bash
pnpm build
mkdir -p .opensip-distribution/tarballs
while IFS= read -r package; do
  pnpm --filter "$package" pack \
    --pack-destination "$PWD/.opensip-distribution/tarballs"
done < <(node scripts/release-package-order.mjs --print pack)
```

Resolve the active pnpm content store and run the default offline measurement:

```bash
PNPM_STORE="$(pnpm store path)"
pnpm distribution:measure -- \
  --dir .opensip-distribution/tarballs \
  --expected-version "$(node -p "require('./package.json').version")" \
  --mode offline-cache \
  --store-dir "$PNPM_STORE" \
  --repeats 20 \
  --out .opensip-distribution/distribution-footprint-report.json
```

The command validates and stages the canonical tarballs at stable relative
paths in a private temporary root. Inputs are bounded before they are copied or
hashed: each compressed tarball is limited to 64 MiB and the complete release
set to 512 MiB. pnpm 11 keeps dependency-resolution metadata outside
`pnpm store path`, so the offline lane also prepares a packed-consumer lock from
the tracked repository lock and a bounded, isolated clone of the local public
registry metadata cache. The clone maps the public-registry metadata into the
exact loopback sentinel cache key (`v11/metadata/127.0.0.1+<port>`) and rejects
links, special files, excessive depth, entries, files, or bytes.

Lock preparation uses its own empty content store and
`--offline --lockfile-only --trust-lockfile`; the measured install separately
uses the caller's prewarmed store with
`--offline --frozen-lockfile --trust-lockfile`. Trusting the seed lock avoids
pnpm 11's supply-chain metadata lookup during a genuinely offline run. The
runner independently proves that every generated third-party package key is a
subset of the tracked repository lock, while local OpenSIP package keys must
point at the staged release tarballs. Both stages use the exact locally cached
pnpm JavaScript runtime pinned by `packageManager`, with Corepack networking
disabled, isolated HOME/XDG/config/cache roots, and a loopback HTTP/CONNECT
sentinel that must observe zero requests.

This preparation is why a newly created machine must first complete the normal
repository install in an approved connected environment. Missing metadata or
package content fails the measurement; the runner never falls back to a
registry. The temporary workspace admits lifecycle execution only for
`better-sqlite3`. In offline mode its lifecycle is forced to build from source,
honor npm offline mode, and route any attempted proxy download to the counted
sentinel. On macOS and Linux, node-gyp receives the active Node installation
prefix through `npm_config_nodedir`. On Windows, the runner instead requires
the exact active Node version and architecture to exist in the standard
`%LOCALAPPDATA%\node-gyp\Cache` (with the normal home-directory fallback),
validates its headers, metadata, and `node.lib`, and copies only that version
into the private temporary root used by `npm_config_devdir`. The Windows copy
rejects links, special files, case-insensitive path collisions, mismatched
headers, and more than 16 levels, 16,384 entries, 8,192 files, 64 MiB per file,
or 256 MiB total. A connected preparation run must populate this cache before
the offline measurement.

Package-manager and dependency lifecycle code still run with the current
user's filesystem authority: this is not an OS sandbox. An OS-level
network-denial sandbox may be used as an additional platform-specific
validation, but it is not part of this portable measurement contract.
Accordingly, a zero sentinel count proves that the package manager and
cooperating lifecycle clients made no request through their configured
registry/proxy path during the bounded run. It does not prove containment of
code that opens a direct socket or deliberately detaches a process; do not
describe the report as an air-gap or network-isolation attestation.

After installation, the runner checks the published CLI contract rather than
assuming that `dist/index.js` is a usable bin: `opensip-cli/package.json` must
be a bounded regular file whose exact `bin.opensip` value is
`./dist/index.js`, and both that target and the generated platform shim
(`node_modules/.bin/opensip` or `opensip.cmd`) must be bounded, non-empty
regular files; the POSIX shim must also be executable. One bounded
`pnpm exec opensip --version` identity probe exercises the generated bin on the
active platform and must return the expected release version. Startup samples
then invoke Node with the same declared JavaScript target through an argv array.
This keeps the recorded samples portable and shell-free; they measure the
installed entrypoint's startup, not pnpm, POSIX-shell, or Windows-`cmd.exe` shim
overhead.

## Optional registry-cold mode

Cold-registry timing is a separate, explicitly outbound measurement. Run it
only with operator authorization and a clean environment:

```bash
pnpm distribution:measure -- \
  --dir .opensip-distribution/tarballs \
  --expected-version "$(node -p "require('./package.json').version")" \
  --mode registry-cold \
  --registry https://registry.npmjs.org \
  --allow-registry \
  --repeats 20 \
  --out .opensip-distribution/distribution-footprint-registry-cold.json
```

The registry origin must be credential-free HTTPS (or loopback HTTP in tests),
with no query or fragment. The cold lane refuses inherited npm/pnpm auth,
registry, and proxy variables before spawning, and uses empty isolated
store/cache/config/home/XDG roots. Never blend its install time with an
`offline-cache` report.

## Schema v1 and interpretation

The report records:

- environment and release identity: timestamp, Node/pnpm/npm, OS/architecture,
  CLI version, git SHA, and an aggregate release-artifact hash;
- every canonical tarball and the complete release-set compressed-byte total;
- a distinct compressed-byte total for only the OpenSIP packages in the
  installed CLI closure;
- install duration/RSS, physical installed bytes/files, bounded dependency
  identity/version rows, and the generated consumer lockfile SHA-256;
- raw bounded samples plus median and nearest-rank p95 for fresh
  `opensip --version`, `opensip --help`, and `opensip init --help` processes;
- compressed and logical unpacked attribution for the six canonical language
  families; and
- explicit caveats describing what the numbers cannot prove.

The complete release set includes unrelated opt-in `tool-*` tarballs, so it is
not the customer's CLI transfer cost. The installed-closure compressed total is
a closer transfer proxy, but neither it nor language-family attribution is a
projected slim-install saving: shared transitive dependencies are not
subtractable. Startup samples exercise the current full host-wired language
substrate. Compare reports only when their release inputs, environments, and
measurement modes are comparable.

Reports contain bounded identities and timings, never command stdout bodies,
environment variables, npmrc/auth material, cache contents, or project source.
Output is written through an exclusive mode-0600 temporary sibling, synced, and
atomically renamed only after the sentinel and temporary-root cleanup succeed.

## Not an air-gap artifact

The tarball directory, prewarmed pnpm store, temporary consumer lock, and JSON
report are measurement inputs/outputs only. They are not a customer runtime
bundle, offline package cache, internal mirror, signed container, installer
receipt, activation pointer, or rollback ledger. Those target-specific trust and
deployment contracts remain behind the named-partner activation gate recorded in
[ADR-0122](../decisions/ADR-0122-agent-workflow-product-wedge.md). The gated local
planning specification is `docs/plans/specs/air-gap-offline-distribution.md` when
that ignored planning tree is present.
