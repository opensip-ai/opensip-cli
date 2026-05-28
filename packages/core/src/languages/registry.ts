// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (registered language adapters and the small file-extension lookup map)
import { extname } from 'node:path'

import { logger } from '../lib/logger.js'
import { Registry, type Registerable } from '../lib/registry.js'

import type { LanguageAdapter } from './adapter.js'

/**
 * Registry of language adapters. Mirrors the shape of `ToolRegistry`:
 * a thin wrapper around the kernel's `Registry<T>` base with two
 * domain-specific indices alongside (`byExtension`, `aliasIndex`) and
 * a `canonicalize` helper.
 *
 * **Duplicate-id policy: first writer wins.** Re-registering the same
 * id keeps the existing entry and emits a structured warning.
 *
 * `LanguageAdapter` has no `name` field — the inner registry stores
 * `{ id, name: id, adapter }` envelopes (same pattern as ToolRegistry).
 */
interface RegisterableLanguageAdapter extends Registerable {
  readonly id: string
  readonly name: string
  readonly adapter: LanguageAdapter
}

/** Per-run registry of language adapters, indexed by id and file extension. */
export class LanguageRegistry {
  private readonly inner = new Registry<RegisterableLanguageAdapter>({
    module: 'core:languages',
    duplicatePolicy: 'warn-first-wins',
    evtPrefix: 'lang.registry',
  })
  private readonly byExtension = new Map<string, LanguageAdapter>()
  /**
   * Alias → canonical id index. Populated alongside the inner registry
   * during `register`. Lets `canonicalize` map an alias like `'c'` or
   * `'rs'` back to the registered adapter id (`'cpp'`, `'rust'`).
   */
  private readonly aliasIndex = new Map<string, string>()

  register(adapter: LanguageAdapter): void {
    const isDuplicate = this.inner.getById(adapter.id) !== undefined
    // Inner registry emits the structured warn event on duplicate;
    // it returns silently after the warn (warn-first-wins policy).
    this.inner.register({ id: adapter.id, name: adapter.id, adapter })
    if (isDuplicate) return
    this.indexExtensions(adapter)
    this.indexAliases(adapter)
  }

  private indexExtensions(adapter: LanguageAdapter): void {
    for (const ext of adapter.fileExtensions) {
      const normalized = ext.toLowerCase()
      const existing = this.byExtension.get(normalized)
      if (existing && existing.id !== adapter.id) {
        logger.warn({
          evt: 'lang.registry.extension.collision',
          module: 'core:languages',
          extension: normalized,
          incumbent: existing.id,
          challenger: adapter.id,
          msg: `Extension ${normalized} already claimed by ${existing.id} — keeping incumbent`,
        })
        continue
      }
      this.byExtension.set(normalized, adapter)
    }
  }

  private indexAliases(adapter: LanguageAdapter): void {
    if (!adapter.aliases) return
    for (const alias of adapter.aliases) {
      const normalized = alias.toLowerCase()
      // An alias that collides with another adapter's canonical id is
      // ignored — the canonical id always wins. Same for an alias
      // already claimed by a previously-registered adapter.
      if (this.inner.getById(normalized) && normalized !== adapter.id) {
        logger.warn({
          evt: 'lang.registry.alias.collision',
          module: 'core:languages',
          alias: normalized,
          incumbent: normalized,
          challenger: adapter.id,
          msg: `Alias ${normalized} already used as a canonical id — ignoring on ${adapter.id}`,
        })
        continue
      }
      const existing = this.aliasIndex.get(normalized)
      if (existing && existing !== adapter.id) {
        logger.warn({
          evt: 'lang.registry.alias.collision',
          module: 'core:languages',
          alias: normalized,
          incumbent: existing,
          challenger: adapter.id,
          msg: `Alias ${normalized} already claimed by ${existing} — keeping incumbent`,
        })
        continue
      }
      this.aliasIndex.set(normalized, adapter.id)
    }
  }

  get(id: string): LanguageAdapter | undefined {
    return this.inner.getById(id)?.adapter
  }

  forFile(filePath: string): LanguageAdapter | undefined {
    const ext = extname(filePath).toLowerCase()
    if (!ext) return undefined
    return this.byExtension.get(ext)
  }

  /**
   * Resolve a language id or alias to its canonical adapter id.
   *
   * - For a registered canonical id (e.g. `'cpp'`), returns the same id.
   * - For a registered alias (e.g. `'c'`, `'rs'`, `'golang'`, `'py'`),
   *   returns the canonical id (`'cpp'`, `'rust'`, `'go'`, `'python'`).
   * - Returns `undefined` for unknown languages.
   *
   * Use this anywhere two pieces of code compare language strings —
   * scope-matching, target-language sets — so a config written with
   * `languages: ['c']` matches a check scoped to `cpp`.
   */
  canonicalize(idOrAlias: string): string | undefined {
    const normalized = idOrAlias.toLowerCase()
    if (this.inner.getById(normalized)) return normalized
    return this.aliasIndex.get(normalized)
  }

  list(): readonly LanguageAdapter[] {
    return this.inner.getAll().map((r) => r.adapter)
  }

  has(id: string): boolean {
    return this.inner.getById(id) !== undefined
  }

  get size(): number {
    return this.inner.size
  }

  clear(): void {
    this.inner.clear()
    this.byExtension.clear()
    this.aliasIndex.clear()
  }
}
