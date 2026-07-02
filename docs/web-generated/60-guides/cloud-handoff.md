---
status: current
last_verified: 2026-06-27
release: v0.2.4
title: "Send CLI findings to OpenSIP Cloud"
audience: [ci-integrators, cloud-adopters]
purpose: "Task-led: hand opensip fit findings to OpenSIP Cloud over --report-to (or the published GitHub Action) so they become tickets — with no manual ingest step."
source-files:
  - packages/output/src/sink/http-egress.ts
  - packages/output/src/sink/repo-slug.ts
  - packages/cli/src/bootstrap/deliver-envelope.ts
  - .github/actions/upload-sarif/action.yml
related-docs:
  - ./03-wire-into-ci.md
  - ../20-fit/04-output-gate-sarif.md
---
# Send CLI findings to OpenSIP Cloud

`opensip fit --report-to <cloud>` ships the run's findings (as SARIF) to your
OpenSIP Cloud tenant. The cloud stores each signal scoped to your repository and
the next reconciler tick turns them into tickets — **there is no manual
`opensip ingest` step.** This is the "Start free with the CLI, go autonomous with
the Cloud" handoff.

Local results are never affected by an upload outcome (ADR-0008): a failed upload
does not change the findings printed in your terminal.

## Prerequisites

1. **An `osk_` API key with `ingest:write`.** Mint a key in OpenSIP Cloud whose
   role is `operator` or `admin` — both carry the `ingest:write` permission. A
   `viewer` key is rejected (see [Troubleshooting](#troubleshooting)).
2. **A git working tree.** The CLI derives an `<org>/<repo>` slug from your
   `origin` remote and sends it as the `x-opensip-repo` header. This is what
   scopes the stored signals to a repository so the reconciler can group them
   into per-`repo:file` tickets. (Repo attribution is the rationale anchor for
   DEC-587; the contract itself is documented there.)

## The one-liner

```bash
opensip fit --report-to https://api.opensip.ai/v1/ingest --api-key osk_…
```

What happens:

- the run is formatted to SARIF and POSTed to `…/v1/ingest/sarif` with
  `Authorization: Bearer osk_…`;
- `x-opensip-repo: <org>/<repo>` (derived from your git remote) is attached;
- the cloud authenticates the key, enforces `ingest:write` (RBAC only — there is
  **no billing/plan gate at the ingest edge**, see DEC-589), and stores the
  signals under your tenant + repo;
- the next reconciler tick creates/updates tickets.

> The endpoint must be `https://`. A Bearer credential is never sent over plain
> HTTP — the CLI refuses an `http://` `--report-to` target when an API key is set.

## In CI

The public root action `opensip-ai/opensip-cli@v1` is the OSS PR-feedback action;
it does not require an API key and does not upload to OpenSIP Cloud. For Cloud
handoff, run the CLI directly or use the nested upload-sarif action path in this
repository.

Direct CLI workflow:

```yaml
# .github/workflows/opensip-cloud-handoff.yml
name: OpenSIP Cloud handoff
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  handoff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4 # a git tree is required for repo attribution
      - uses: actions/setup-node@v6
        with:
          node-version: 24
      - run: npx --yes opensip-cli@latest fit --report-to https://api.opensip.ai/v1/ingest --api-key "$OPENSIP_API_KEY"
        env:
          OPENSIP_API_KEY: ${{ secrets.OPENSIP_API_KEY }}
```

Store the key as the repository/organization secret `OPENSIP_API_KEY`. The full
input list (`cloud-url`, `args`, `working-directory`, `version`,
`fail-on-upload-error`) is documented in
the nested action docs:
[`.github/actions/upload-sarif/README.md`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.4/.github/actions/upload-sarif/README.md).

## Exit codes

- **`0`** — fit passed and the upload succeeded.
- **`4`** — fit otherwise passed but the SARIF upload failed. A report-upload
  failure only takes the exit code when the run otherwise passed; a real
  findings/gate failure always dominates.
- **other non-zero** — a real findings/gate failure.

The Action maps these: a pure upload failure (exit 4) is gated by its
`fail-on-upload-error` input (default fails the job); a findings/gate failure
always fails the job.

## Troubleshooting

The CLI distinguishes the two auth failures on stderr so you know what to fix:

- **`401` — "the API key was rejected; check --api-key / your config".** The key
  is unknown or malformed. Confirm you passed a full `osk_…` token.
- **`403` — "the API key lacks the `ingest:write` permission; use an
  operator/admin key".** The key authenticated but its role omits `ingest:write`.
  Mint an `operator`/`admin` key.

If the upload fails for any other reason, your local results are still complete —
only the cloud handoff was skipped.
