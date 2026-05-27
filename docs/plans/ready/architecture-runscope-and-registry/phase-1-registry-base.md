# Phase 1: Build `Registry<T>` base class in core

**Goal:** Land `packages/core/src/lib/registry.ts` exporting `Registry<T>` + `DuplicatePolicy` + `Registerable` + `RegistryOptions` per the Phase 0 design. Comprehensive tests. **No consumers migrated yet** — the existing eleven registry classes keep working.

**Depends on:** Phase 0 (all four tasks must be recorded under "Decisions").

This phase establishes the new base in isolation. Phase 2 starts migration. Keeping the two universes side-by-side for one phase means Phase 1 can land + ship + sit in CI for a day or two before any consumer touches it, surfacing API issues early.

---

## Task 1.1: Write `Registry<T>` source

**Files:**
- Create: `packages/core/src/lib/registry.ts`
- Modify: `packages/core/src/index.ts` (barrel)

**Context:** Per Phase 0 Task 0.2, the API is locked in. Implementation is straightforward — three Maps, a policy switch, structured events.

**Steps:**

1. Write `packages/core/src/lib/registry.ts`:

   ```typescript
   import { logger as defaultLogger, type Logger } from './logger.js';
   import { ValidationError } from './errors.js';

   export type DuplicatePolicy =
     | 'warn-first-wins'
     | 'throw'
     | 'overwrite'
     | 'silent-skip'
     | 'allow-internal';

   export interface Registerable {
     readonly id: string;
     readonly name: string;
     readonly tags?: readonly string[];
   }

   export interface RegistryOptions {
     readonly module: string;
     readonly duplicatePolicy: DuplicatePolicy;
     readonly evtPrefix: string;
     readonly validationCode?: string;
     readonly nameCollisionMode?: 'allow' | 'throw';
     readonly logger?: Logger;
   }

   export interface RegisterCallOptions {
     /** Bypass the duplicate guard for this single call. Use for built-in seeding. */
     readonly internal?: boolean;
     /** Source package id — included in structured events for third-party warnings. */
     readonly sourcePackage?: string;
   }

   export class Registry<T extends Registerable> {
     private readonly byId = new Map<string, T>();
     private readonly byName = new Map<string, T>();
     private readonly opts: Required<Omit<RegistryOptions, 'validationCode'>> & Pick<RegistryOptions, 'validationCode'>;

     constructor(opts: RegistryOptions) {
       this.opts = {
         module: opts.module,
         duplicatePolicy: opts.duplicatePolicy,
         evtPrefix: opts.evtPrefix,
         nameCollisionMode: opts.nameCollisionMode ?? 'allow',
         logger: opts.logger ?? defaultLogger,
         validationCode: opts.validationCode,
       };
     }

     register(item: T, callOpts: RegisterCallOptions = {}): void {
       const { byId, byName, opts } = this;
       const internal = callOpts.internal === true;

       // Name-collision guard (orthogonal to duplicate policy).
       const nameIncumbent = byName.get(item.name);
       if (nameIncumbent && nameIncumbent.id !== item.id && opts.nameCollisionMode === 'throw') {
         throw new ValidationError(
           `${opts.module}: name collision — '${item.name}' is already registered with id '${nameIncumbent.id}', cannot register id '${item.id}' with the same name`,
           { code: opts.validationCode ?? 'VALIDATION.REGISTRY.NAME_COLLISION' },
         );
       }

       // Duplicate-id branch.
       const idIncumbent = byId.get(item.id);
       const isDup = idIncumbent !== undefined || (nameIncumbent !== undefined && nameIncumbent.id !== item.id);

       if (isDup && !internal) {
         switch (opts.duplicatePolicy) {
           case 'silent-skip':
             return;
           case 'warn-first-wins':
             opts.logger.warn({
               evt: `${opts.evtPrefix}.duplicate`,
               module: opts.module,
               id: item.id,
               name: item.name,
               sourcePackage: callOpts.sourcePackage,
               msg: `${item.id} already registered — keeping incumbent`,
             });
             return;
           case 'throw':
             throw new ValidationError(
               `${opts.module}: '${item.name}' (${item.id}) already registered`,
               { code: opts.validationCode ?? 'VALIDATION.REGISTRY.DUPLICATE' },
             );
           case 'overwrite':
             // Drop stale mappings before re-insert.
             if (idIncumbent && idIncumbent.name !== item.name) byName.delete(idIncumbent.name);
             if (nameIncumbent && nameIncumbent.id !== item.id) byId.delete(nameIncumbent.id);
             break;
           case 'allow-internal':
             // First write is allowed (treated as if `internal: true` were passed);
             // subsequent dup is a throw. The use case is "register built-ins
             // unconditionally" without a per-call flag at the seed site.
             // For default policy = allow-internal, we treat non-internal dup as throw.
             throw new ValidationError(
               `${opts.module}: '${item.name}' (${item.id}) already registered (allow-internal: only the first write is permitted without { internal: true })`,
               { code: opts.validationCode ?? 'VALIDATION.REGISTRY.DUPLICATE' },
             );
         }
       }

       byId.set(item.id, item);
       byName.set(item.name, item);
     }

     registerAll(items: readonly T[], callOpts: RegisterCallOptions = {}): void {
       for (const item of items) this.register(item, callOpts);
     }

     get(idOrName: string): T | undefined {
       return this.byId.get(idOrName) ?? this.byName.get(idOrName);
     }
     getById(id: string): T | undefined { return this.byId.get(id); }
     getByName(name: string): T | undefined { return this.byName.get(name); }
     has(idOrName: string): boolean { return this.byId.has(idOrName) || this.byName.has(idOrName); }
     getAll(): readonly T[] { return [...this.byId.values()]; }
     getByTag(tag: string): readonly T[] { return this.getAll().filter(i => i.tags?.includes(tag)); }
     remove(id: string): boolean {
       const item = this.byId.get(id);
       if (!item) return false;
       this.byId.delete(id);
       this.byName.delete(item.name);
       return true;
     }
     clear(): void { this.byId.clear(); this.byName.clear(); }
     get size(): number { return this.byId.size; }
   }
   ```

2. Add re-exports to `packages/core/src/index.ts`:

   ```typescript
   export {
     Registry,
     type DuplicatePolicy,
     type Registerable,
     type RegistryOptions,
     type RegisterCallOptions,
   } from './lib/registry.js';
   ```

   Do NOT remove the `IdNameTagRegistry` / `RecipeRegistry` exports yet — those are removed in Phase 2 once consumers migrate.

**Observability:** Each duplicate event emits with the structured fields above (`evt`, `module`, `id`, `name`, optional `sourcePackage`). Consistent across every consumer.

**Wiring:** New file + barrel re-export. No other package touched.

**Error cases:** `register()` throws `ValidationError` on `'throw'` policy duplicates and on `nameCollisionMode: 'throw'` collisions. The base never logs at error level — only `warn` for the `warn-first-wins` policy. Other duplicate outcomes are silent (`silent-skip`) or replacing (`overwrite`).

**Verification:**
```bash
pnpm --filter @opensip-tools/core build
pnpm --filter @opensip-tools/core typecheck
```

**Commit:** `feat(core): Registry<T> base class with closed DuplicatePolicy union`

---

## Task 1.2: Write the test suite

**Files:**
- Create: `packages/core/src/lib/__tests__/registry.test.ts`

**Context:** Comprehensive coverage of all five policies + name-collision modes + the `internal` opt-in. This is the contract test the migrated consumers in Phase 3 will lean on.

**Steps:**

1. Create the test file with these describe blocks:

   ```typescript
   describe('Registry<T> — duplicatePolicy: warn-first-wins', () => {
     // - First register: succeeds
     // - Duplicate id: warn event fires, incumbent kept
     // - Duplicate name with different id: warn fires (orthogonal to nameCollisionMode default 'allow')
     // - sourcePackage included in event when passed
   });
   describe('Registry<T> — duplicatePolicy: throw', () => {
     // - Duplicate id: throws ValidationError with configured validationCode
     // - { internal: true }: bypasses the throw
     // - registerAll respects per-call options
   });
   describe('Registry<T> — duplicatePolicy: overwrite', () => {
     // - Duplicate id with different name: stale name mapping removed
     // - Duplicate name with different id: stale id mapping removed
     // - {byId, byName} stay consistent after overwrite
   });
   describe('Registry<T> — duplicatePolicy: silent-skip', () => {
     // - Duplicate id: returns silently, no event, incumbent kept
   });
   describe('Registry<T> — duplicatePolicy: allow-internal', () => {
     // - First non-internal register: succeeds
     // - Second non-internal register: throws
     // - { internal: true }: bypasses
   });
   describe('Registry<T> — nameCollisionMode: throw', () => {
     // - Same name, different id, with mode='throw': throws
     // - Same name, different id, with mode='allow' (default): falls through to duplicatePolicy
     // - Same name, same id: not a collision, treated by duplicatePolicy
   });
   describe('Registry<T> — accessors', () => {
     // - get / getById / getByName / has / getAll / getByTag / remove / clear / size
   });
   ```

2. Use `vi.spyOn(logger, 'warn')` to assert event payload shape (`evt`, `module`, `id`, `sourcePackage`).

3. Aim for ≥ 95% statement coverage on `registry.ts`. The file is small (~120 LOC); the policy switch is the bulk and every branch should have ≥ 1 test.

**Observability:** Tests verify the structured-event shape via spy assertions.

**Wiring:** Test-only.

**Error cases:** Each `'throw'`-policy test asserts both that a `ValidationError` is thrown and that its `code` field matches the configured `validationCode`. Each `'warn-first-wins'`-policy test asserts both that `logger.warn` was called and that the spy was not called with `level: 'error'`.

**Verification:**
```bash
pnpm --filter @opensip-tools/core test src/lib/__tests__/registry.test.ts
pnpm --filter @opensip-tools/core test  # full core suite stays green
```

**Commit:** `test(core): Registry<T> contract tests across all 5 duplicate policies`

---

## End-of-phase verification

```bash
pnpm --filter @opensip-tools/core build
pnpm --filter @opensip-tools/core test
pnpm typecheck
pnpm lint
```

Acceptance:

- [ ] `packages/core/src/lib/registry.ts` exists and is exported from the core barrel.
- [ ] Registry test file covers all 5 duplicate policies + both `nameCollisionMode` settings + the `internal` opt-in.
- [ ] No existing registry class (IdNameTagRegistry, ToolRegistry, etc.) has been touched.
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm lint` all green.
