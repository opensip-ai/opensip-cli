# @opensip-tools/targeting

The host file-targeting runtime substrate (ADR-0037). It holds the **generic
half** of file targeting any tool consumes via `scope.targets`: the
`TargetRegistry` (register/get/byTag over the host-owned `Target` shape), the
uniform glob expansion (`resolveTargets` / `preResolveAllTargets`, always
applying per-target `exclude` **and** `globalExcludes`), and
`applyGlobalExcludes`. It is a peer of `lang-*`/`output`, depends only on
`@opensip-tools/config` (targeting types), `@opensip-tools/core` (the generic
`Registry<T>` base), and `glob`/`minimatch` — never a tool engine, the CLI, or
check packs. The check-domain half (per-check overrides, scope matching,
content cache) stays in `@opensip-tools/fitness`.
