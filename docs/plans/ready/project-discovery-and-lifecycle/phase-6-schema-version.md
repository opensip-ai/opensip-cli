# Phase 6: Schema version

**Goal:** Add `schemaVersion: 1` to `opensip-tools.config.yml`. When the config is *newer* than the CLI understands, error with "upgrade your CLI" — pointing at `npm install -g @opensip-tools/cli@latest`. When the config is *older*, log an info line and continue (silent for users — the future `migrate` command will eventually surface this, but until it ships there's nothing actionable to say).
**Depends on:** Phase 3

**Critical messaging correction:** A previous draft of this phase had the message direction backwards — it told users to "run migrate" when the config was newer than the CLI. That doesn't work: `migrate` exists to take an *older* config up to the *current* CLI's version. When a config is newer than the CLI, the user needs to *upgrade the CLI*. The reviewer caught this; the fix is in Task 6.3 below.

The `migrate` command itself is **out of scope** for this plan.

---

## Task 6.1: Add permissive `readConfigSchemaVersion` reader in core

**Files:** [size: S]
- Create: `packages/core/src/lib/config-version.ts`
- Modify: `packages/core/src/index.ts`

**Context:** Detection runs in `pre-action-hook` before any tool's strict loader. Reading must be permissive (missing field, missing file, malformed YAML → all treated as v1). Mirrors `loadCliDefaults` (`packages/contracts/src/cli-config.ts:96`).

**Steps:**

1. Create `packages/core/src/lib/config-version.ts`:

   ```ts
   /**
    * Permissive reader for the top-level `schemaVersion:` field of
    * opensip-tools.config.yml + compatibility classifier.
    *
    * Missing field, malformed YAML, missing file — all treated as v1.
    * Forward compat for existing user configs written before the field
    * existed.
    */

   import { existsSync } from 'node:fs';

   import { readYamlFile } from './yaml.js';

   /**
    * The schema version this CLI binary knows how to load. Bumped when
    * the project config structure changes in a way that requires
    * migration.
    */
   export const CLI_SUPPORTED_SCHEMA_VERSION = 1 as const;

   /** Outcome of `checkSchemaCompat`. */
   export type SchemaCompat =
     | { readonly kind: 'ok'; readonly configVersion: number }
     | { readonly kind: 'older'; readonly configVersion: number; readonly cliVersion: number }
     | { readonly kind: 'cli-too-old'; readonly configVersion: number; readonly cliVersion: number };

   /**
    * Read the top-level `schemaVersion:` field. Returns 1 for any
    * "couldn't read it" outcome, by design.
    */
   export function readConfigSchemaVersion(configPath: string): number {
     if (!existsSync(configPath)) return 1;
     const doc = readYamlFile(configPath);
     if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return 1;
     const raw = (doc as Record<string, unknown>).schemaVersion;
     if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return 1;
     return raw;
   }

   /**
    * Classify a config's declared version against the CLI's supported version.
    *
    * - `ok`           — versions match; proceed silently.
    * - `older`        — config is older than CLI; CLI can read it (today).
    *                    Future: `opensip-tools migrate` updates it. For now,
    *                    the CLI runs it as-is; pre-action-hook logs the skew
    *                    at info but does not surface a user-visible message
    *                    (nothing actionable yet).
    * - `cli-too-old`  — config is newer than CLI knows. The CLI cannot safely
    *                    load it. User must upgrade the CLI.
    */
   export function checkSchemaCompat(configVersion: number): SchemaCompat {
     if (configVersion === CLI_SUPPORTED_SCHEMA_VERSION) {
       return { kind: 'ok', configVersion };
     }
     if (configVersion < CLI_SUPPORTED_SCHEMA_VERSION) {
       return { kind: 'older', configVersion, cliVersion: CLI_SUPPORTED_SCHEMA_VERSION };
     }
     return { kind: 'cli-too-old', configVersion, cliVersion: CLI_SUPPORTED_SCHEMA_VERSION };
   }
   ```

   The kind name change from the prior draft (`needs-migration` → `cli-too-old`) reflects the corrected direction: when the config is newer, the *CLI* is what needs updating, not the config. Naming follows the corrected intent.

2. Re-export from `packages/core/src/index.ts`:

   ```ts
   export {
     CLI_SUPPORTED_SCHEMA_VERSION,
     readConfigSchemaVersion,
     checkSchemaCompat,
     type SchemaCompat,
   } from './lib/config-version.js';
   ```

**Wiring:** Standalone reader. Task 6.3 wires it.

**Verification:**
```bash
pnpm --filter=@opensip-tools/core build && pnpm --filter=@opensip-tools/core typecheck
```

**Commit:** `feat(core): add permissive readConfigSchemaVersion + compat check`

---

## Task 6.2: Add `schemaVersion` to the strict Zod schema

**Files:** [size: XS]
- Modify: `packages/fitness/engine/src/signalers/schema.ts`

**Context:** `SignalersConfigSchema` (line 121) is the strict validator. The new field must be accepted so existing configs still validate and newly scaffolded configs match.

**Steps:**

1. Add to the `z.object({...})` at line 121:

   ```ts
   schemaVersion: z.number().int().min(1).default(1),
   ```

**Verification:**
```bash
pnpm --filter=@opensip-tools/fitness build && pnpm --filter=@opensip-tools/fitness test signalers
```

**Commit:** `feat(fitness): accept schemaVersion in SignalersConfigSchema`

---

## Task 6.3: Detect skew in `pre-action-hook` and emit the corrected message

**Files:** [size: M]
- Modify: `packages/cli/src/bootstrap/pre-action-hook.ts`

**Context:** With context resolved (Phase 1) and the reader available (Task 6.1), the hook detects skew. The crucial correction from the review: when the config is newer than the CLI, the *user must upgrade the CLI*, not run `migrate`. Migrate exists to take an OLDER config UP to the CLI's current schema; it cannot help with the inverse problem.

The error path uses `process.exit(2)` directly (same rationale as Task 1.4's existsSync gate — throwing from preAction produces noisy stack traces).

**Steps:**

1. Add imports:

   ```ts
   import { checkSchemaCompat, readConfigSchemaVersion } from '@opensip-tools/core';
   ```

2. After the discovery block (Task 1.2) and BEFORE the Project header (Task 2.2), only when `project.scope === 'project'`:

   ```ts
   if (project.scope === 'project' && project.configPath) {
     const configVersion = readConfigSchemaVersion(project.configPath);
     const compat = checkSchemaCompat(configVersion);
     if (compat.kind === 'cli-too-old') {
       const msg = formatCliTooOldMessage({
         root: project.projectRoot,
         configVersion: compat.configVersion,
         cliVersion: compat.cliVersion,
       });
       process.stderr.write(`${msg}\n`);
       logger.warn({
         evt: 'cli.config.schema.cli-too-old',
         module: 'cli:bootstrap',
         root: project.projectRoot,
         configVersion: compat.configVersion,
         cliVersion: compat.cliVersion,
       });
       process.exit(2);
     }
     if (compat.kind === 'older') {
       logger.info({
         evt: 'cli.config.schema.older',
         module: 'cli:bootstrap',
         root: project.projectRoot,
         configVersion: compat.configVersion,
         cliVersion: compat.cliVersion,
       });
       // No user-visible message until `opensip-tools migrate` exists. When that
       // command ships, this branch grows: "Your config (schema v<old>) is older
       // than this CLI (v<new>). Run `opensip-tools migrate` to update it."
     }
   }
   ```

3. Add the corrected message helper at the bottom of the file:

   ```ts
   interface CliTooOldInput {
     readonly root: string;
     readonly configVersion: number;
     readonly cliVersion: number;
   }

   function formatCliTooOldMessage(input: CliTooOldInput): string {
     return [
       `✗ This project's opensip-tools.config.yml uses a newer schema than your CLI supports.`,
       ``,
       `  Project:        ${input.root}`,
       `  Config schema:  v${input.configVersion}`,
       `  CLI supports:   v${input.cliVersion}`,
       ``,
       `  Update your CLI to continue:`,
       `    npm install -g @opensip-tools/cli@latest`,
       ``,
       `  (Or, if installed locally to the project: pnpm up @opensip-tools/cli@latest)`,
     ].join('\n');
   }
   ```

**Wiring:** Runs once per command invocation. Exits the process on `cli-too-old`. Phase 7's phantom-detect runs after this since both depend on `project` being computed.

**Verification:**
```bash
pnpm build && pnpm typecheck
```

Manual smoke — fabricate a config with `schemaVersion: 99` and any command:

```bash
TMPDIR=$(mktemp -d) && cd "$TMPDIR" && \
  echo 'schemaVersion: 99' > opensip-tools.config.yml && \
  node /path/to/cli/dist/index.js fit
# Expected: stderr shows "uses a newer schema than your CLI supports" + npm install hint, exit 2.
```

**Commit:** `feat(cli): detect config schema skew; emit upgrade-CLI message when CLI is older`

---

## Task 6.4: Write `schemaVersion: 1` in scaffolded configs

**Files:** [size: XS]
- Modify: `packages/cli/src/commands/init.ts`

**Context:** `executeInit` writes config via `writeFileSync(paths.configFile, generateConfig(languages), 'utf8')` at line 845. Update `generateConfig` to prepend the field.

**Steps:**

1. Find `generateConfig` (search the file). Update to prepend:

   ```ts
   `schemaVersion: ${CLI_SUPPORTED_SCHEMA_VERSION}`,
   ``,
   ...existingBodyLines(languages),
   ```

2. Import `CLI_SUPPORTED_SCHEMA_VERSION` from `@opensip-tools/core` at the top of `init.ts`. Interpolating the constant keeps the scaffold automatically current.

**Verification:**
```bash
pnpm build && \
TMPDIR=$(mktemp -d) && cd "$TMPDIR" && \
  node /path/to/cli/dist/index.js init && \
  head -2 opensip-tools.config.yml
# Expected first line: schemaVersion: 1
```

**Commit:** `feat(cli): write schemaVersion: 1 in scaffolded configs`

---

## Phase 6 End-to-End Verification

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

After this phase:
- Newly initialized projects have `schemaVersion: 1`.
- Existing configs missing the field load silently as v1.
- A config with `schemaVersion: 99` errors with the **upgrade-CLI** message + exit 2 (corrected direction).
- A config with `schemaVersion: 0` or non-integer treated as v1.
- A config with `schemaVersion: <less than current>` logs an info line; no user-visible message yet (will surface when `migrate` ships).

> **Deferred:** The `opensip-tools migrate` command itself. When it lands, the `older` branch grows a user-visible message pointing at it.
