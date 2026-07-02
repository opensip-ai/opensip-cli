# OpenSIP CLI — Cloud signal handoff Action

Run `opensip fit` in CI and ship the findings (SARIF) to your OpenSIP Cloud
tenant on every PR or push. The findings are authenticated with an `osk_` API
key, attributed to the repository via the `x-opensip-repo` header, and turned
into tickets by the next reconciler tick — **no manual `opensip ingest` step.**

The public repository root action (`opensip-ai/opensip-cli@v1`) is the OSS
PR-feedback action. This Cloud handoff composite lives at
`.github/actions/upload-sarif/action.yml` for repository-local workflows and for
consumers that intentionally vendor/reference this nested path.

## Quick start

```yaml
# .github/workflows/opensip-cloud-handoff.yml
name: OpenSIP Cloud handoff
on:
  pull_request:
  push:
    branches: [main]

jobs:
  opensip:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4 # a git working tree is required for repo attribution
      - uses: opensip-ai/opensip-cli/.github/actions/upload-sarif@main
        with:
          api-key: ${{ secrets.OPENSIP_API_KEY }}
```

## Inputs

| Input                  | Required | Default                            | Description                                                                                                |
| ---------------------- | -------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `api-key`              | yes      | —                                  | An OpenSIP Cloud API key (`osk_…`) with the `ingest:write` permission (operator/admin role). Use a secret. |
| `cloud-url`            | no       | `https://api.opensip.ai/v1/ingest` | Ingest base URL. The CLI appends `/sarif`. Must be `https://`.                                             |
| `args`                 | no       | `''`                               | Extra `opensip fit` args (e.g. `--recipe my-recipe`, `--tags security`).                                   |
| `working-directory`    | no       | `.`                                | Directory to run from. Must be a checked-out git tree for `<org>/<repo>` derivation.                       |
| `version`              | no       | `latest`                           | `opensip-cli` npm version to run via npx.                                                                  |
| `fail-on-upload-error` | no       | `true`                             | Fail the job on a pure upload failure (CLI exit 4). Real findings/gate failures always fail the job.       |

## Prerequisites

1. **An `osk_` key with `ingest:write`.** Mint an OpenSIP Cloud API key whose
   role is `operator` or `admin` (both carry `ingest:write`). A `viewer` key is
   rejected with `403` — see Troubleshooting.
2. **A checked-out git working tree** (`actions/checkout@v4`) so the CLI can read
   the origin remote and derive `x-opensip-repo: <org>/<repo>`.

## How it works

`opensip fit --report-to <cloud-url> --api-key osk_…`:

- formats the run to SARIF and POSTs it to `<cloud-url>/sarif` with
  `Authorization: Bearer osk_…`,
- attaches `x-opensip-repo: <org>/<repo>` derived from the git remote,
- the cloud authenticates the key, enforces `ingest:write`, and stores each
  signal scoped to your tenant + repo,
- the next reconciler tick creates/updates tickets.

## Exit-code contract

- **`0`** — fit passed and the upload succeeded.
- **`4`** — fit otherwise passed but the SARIF upload failed; gated by
  `fail-on-upload-error` (default fails the job).
- **other non-zero** — a real findings/gate failure; always fails the job.

## Troubleshooting

- **`401` / "the API key was rejected"** — the key is unknown or malformed.
  Check the `OPENSIP_API_KEY` secret holds a full `osk_…` token.
- **`403` / "the API key lacks the `ingest:write` permission"** — the key is
  valid but its role omits `ingest:write`. Use an `operator`/`admin` key.

See the reader-facing guide: `docs/public/60-guides/cloud-handoff.md`.
