# Enterprise policy governance (internal)

Consolidated operator posture for privacy, credentials, outbound I/O, i18n, and
extension trust. Public summaries live under `docs/public/`; durable decisions in
`docs/decisions/ADR-0068` through `ADR-0073`.

## Outbound network (ADR-0070)

| Surface | Default | Disable |
|---------|---------|---------|
| OpenTelemetry | Off | Unset `OTEL_EXPORTER_OTLP_ENDPOINT` |
| OpenSIP Cloud sync | Off without API key/entitlement | `--no-cloud`, user/project config |
| Update notifications | On for TTY (hourly npm check) | `OPENSIP_NO_UPDATE=1`, `NO_UPDATE_NOTIFIER=1`, non-TTY, CI |
| Supply-chain/release scripts | Local file reads only | n/a |

No source contents, credentials, or registry tokens are sent in telemetry, cloud
sync payloads, or update-state files.

## Credentials (ADR-0071)

- Allowed sources: `--api-key`, `OPENSIP_API_KEY`, `~/.opensip-cli/config.yml#apiKey`
- **Forbidden:** `cli.apiKey` in project `opensip-cli.config.yml` (strict validation error)
- User config writes use atomic `0o600` files

## i18n (ADR-0072)

- CLI and docs are **English-only** today
- Programming-language adapters are unrelated to UI localization
- Revisit when: enterprise contract requires translated CLI, maintained docs
  translation process exists, or an extraction owner is named

## Consumption-side verification (ADR-0068)

- Producer provenance ships via OIDC/`--provenance` releases
- Install/load verification for non-bundled packages is **policy-only** until spec 03
  implements enforcement — see `docs/internal/plugin-isolation-surface.md`

## Dependency hygiene (ADR-0069)

See `docs/internal/supply-chain-dependency-hygiene-improvement-process.md`.