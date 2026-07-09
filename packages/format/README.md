# @opensip-cli/format

Pure, zero-dependency human presentation formatters and narrow display
projections for OpenSIP CLI (ADR-0144).

**Owns:** lexical labels — how raw `durationMs` / `score` become human strings.

**Does not own:** suite aggregation, pass rates, status, counts, or wall-clock
policy. Upstream computes the raw fact; this package only labels it.

Consumers: `cli-ui`, dashboard client, host CLI history, and any surface that
must show the same duration/score string as the report.
