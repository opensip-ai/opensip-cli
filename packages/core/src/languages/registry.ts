import { extname } from 'node:path'

import { logger } from '../lib/logger.js'

import type { LanguageAdapter } from './adapter.js'

/**
 * Registry of language adapters. Mirrors the shape of `ToolRegistry`.
 * Language IDs are globally unique — no namespace dimension.
 *
 * **Duplicate-id policy: first writer wins.** Re-registering the same
 * id keeps the existing entry and emits a structured warning. Same
 * semantics as `ToolRegistry`.
 */
export class LanguageRegistry {
  private readonly byId = new Map<string, LanguageAdapter>()
  private readonly byExtension = new Map<string, LanguageAdapter>()
  /**
   * Alias → canonical id index. Populated alongside `byId` during
   * `register`. Lets `canonicalize` map an alias like `'c'` or `'rs'`
   * back to the registered adapter id (`'cpp'`, `'rust'`).
   */
  private readonly aliasIndex = new Map<string, string>()

  register(adapter: LanguageAdapter): void {
    if (this.byId.has(adapter.id)) {
      logger.warn({
        evt: 'lang.registry.duplicate',
        module: 'core:languages',
        id: adapter.id,
        msg: `Language id ${adapter.id} already registered — keeping incumbent`,
      })
      return
    }
    this.byId.set(adapter.id, adapter)
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
      if (this.byId.has(normalized) && normalized !== adapter.id) {
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
    return this.byId.get(id)
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
    if (this.byId.has(normalized)) return normalized
    return this.aliasIndex.get(normalized)
  }

  list(): readonly LanguageAdapter[] {
    return [...this.byId.values()]
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  get size(): number {
    return this.byId.size
  }

  clear(): void {
    this.byId.clear()
    this.byExtension.clear()
    this.aliasIndex.clear()
  }
}

/** Default global registry — language packs register here on load. */
export const defaultLanguageRegistry = new LanguageRegistry()
