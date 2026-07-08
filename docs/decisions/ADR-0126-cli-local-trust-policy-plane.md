---
status: active
enforcement: mechanizable
enforced-by: ['depcruise:core-imports-nothing-workspace']
---

# ADR-0126: CLI-Local Trust Policy Plane

## Status

Accepted

## Context

OpenSIP CLI already had several local trust gates: installed Tool packages,
project-local authored Tools, user-global authored Tools, capability packs,
fitness disabled checks, and baseline capture. Those decisions were correct for
the default OSS posture, but the rules were spread across bootstrap and command
handlers, making strict enterprise posture and audit evidence hard to reason
about.

The CLI must stay deterministic and offline. It must not call OpenSIP Cloud,
npm, GitHub, or any model to decide whether local code may execute. Cloud/org
policy can be represented only as an offline cache input in this repository.

## Decision

`@opensip-cli/config` owns the single pure policy decision point:
`evaluateTrustPolicy(policy, request)`. The config package also owns the strict
`policy:` schema and source resolver. `@opensip-cli/core` carries only opaque
`RunScope.trustPolicy` and `RunScope.policyAudit` slots so lower layers do not
import config.

The CLI composition root owns thin policy-enforcement points:

- installed Tool discovery and authored Tool admission;
- capability-pack admission;
- `tools install` activation;
- `fitness.disabledChecks` on fitness runs;
- host baseline capture (`--gate-save`);
- `policy status`, `policy explain`, and `policy audit`.

Default mode preserves existing local behavior. Strict mode denies unverified
non-bundled executable loads/installs and gate-weakening actions unless an
unexpired exact exception applies. The initial provenance verifier is local and
deterministic: bundled first-party packages are verified by the release trust
base; non-bundled packages are `unavailable` until a future local verifier
supplies signed evidence.

Policy audit events are host-owned persistence in `@opensip-cli/datastore`
(`policy_audit_events`). The table stores bounded strings and JSON blobs only;
tools never write it and datastore never imports the policy evaluator.

## Consequences

- A new local `policy:` config block is strict-validated with the rest of the
  project document.
- `policy.org.required: true` fails closed when the configured project-local
  org cache is missing, stale, invalid, oversized, or escapes the project root.
- `opensip policy audit` is the durable local evidence surface for policy
  decisions.
- Future online/org policy services must feed the same resolver through a
  bounded offline cache; they do not add a second PDP to the CLI.
