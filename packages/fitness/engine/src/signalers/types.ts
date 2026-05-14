/**
 * @fileoverview Signalers configuration types — derived from Zod schemas
 */

import type { SignalersConfigSchema } from './schema.js'
import type { z } from 'zod'


/** Recursively marks all properties as readonly. */
type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K]
}

/** Top-level signalers configuration. */
export type SignalersConfig = DeepReadonly<z.infer<typeof SignalersConfigSchema>>
