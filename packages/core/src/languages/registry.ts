import { extname } from 'node:path'

import { logger } from '../lib/logger.js'

import type { LanguageAdapter } from './adapter.js'

/**
 * Registry of language adapters. Mirrors the shape of CheckRegistry.
 * Language IDs are globally unique — no namespace dimension.
 */
export class LanguageRegistry {
  private readonly byId = new Map<string, LanguageAdapter>()
  private readonly byExtension = new Map<string, LanguageAdapter>()

  register(adapter: LanguageAdapter): void {
    if (this.byId.has(adapter.id)) {
      logger.debug({
        evt: 'lang.registry.duplicate',
        module: 'core:languages',
        id: adapter.id,
      })
      return
    }
    this.byId.set(adapter.id, adapter)
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

  get(id: string): LanguageAdapter | undefined {
    return this.byId.get(id)
  }

  forFile(filePath: string): LanguageAdapter | undefined {
    const ext = extname(filePath).toLowerCase()
    if (!ext) return undefined
    return this.byExtension.get(ext)
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
  }
}

/** Default global registry — language packs register here on load. */
export const defaultLanguageRegistry = new LanguageRegistry()
