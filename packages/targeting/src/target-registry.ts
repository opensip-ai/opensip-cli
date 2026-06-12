/**
 * @fileoverview Target Registry (host substrate)
 *
 * Registry for target definitions. Provides lookup by name and tags.
 *
 * Built on the kernel's unified `Registry<T>` with `silent-skip` —
 * registering a target with a name that's already taken is a no-op
 * (the historical behaviour).
 *
 * The entire targets module uses a synchronous API because target definitions
 * are loaded once at startup from a small YAML config file and then held
 * in-memory for fast, repeated lookups throughout the process lifetime. The
 * resolver (resolve.ts) similarly uses synchronous glob expansion. Since the
 * data set is small and bounded by project configuration, async I/O offers no
 * practical benefit and would complicate every call site that queries targets.
 *
 * This is the **generic** half of file targeting (ADR-0037): register/get/byTag
 * over the host-owned `Target` shape. The scope-matching `findByScope`
 * (languages + concerns) stays in `@opensip-cli/fitness` — `concerns` is a
 * check-scope concept, so the substrate carries no language-canonicalizing path
 * and never reads the run scope.
 */

import { Registry, type Registerable } from '@opensip-cli/core';

import type { Target } from '@opensip-cli/config';

interface RegisterableTarget extends Registerable {
  readonly id: string; // same as target.config.name (Target has no id today)
  readonly name: string;
  readonly target: Target;
  readonly tags?: readonly string[];
}

/** Registry for target definitions with lookup by name and tags. */
export class TargetRegistry {
  private readonly inner = new Registry<RegisterableTarget>({
    module: 'targeting',
    duplicatePolicy: 'silent-skip',
    evtPrefix: 'target.registry',
  });

  /**
   * Register a target. Silently skips if a target with the same name already exists.
   * @param target - Target definition to register
   * @returns This registry instance for chaining
   */
  register(target: Target): this {
    const name = target.config.name;
    this.inner.register({
      id: name,
      name,
      target,
      tags: target.config.tags,
    });
    return this;
  }

  /**
   * Look up a target by its config name.
   * @param name - Target name to find
   * @returns The matching target, or undefined if not found
   */
  getByName(name: string): Target | undefined {
    return this.inner.getById(name)?.target;
  }

  /** Return all registered targets. */
  getAll(): readonly Target[] {
    return this.inner.getAll().map((r) => r.target);
  }

  /**
   * Return all targets that include the given tag.
   * @param tag - Tag string to filter by
   * @returns Targets whose config.tags contain the tag
   */
  getByTag(tag: string): readonly Target[] {
    return this.inner.getByTag(tag).map((r) => r.target);
  }

  /**
   * Check whether a target with the given name is registered.
   * @param name - Target name to check
   * @returns True if the target exists in the registry
   */
  has(name: string): boolean {
    return this.inner.has(name);
  }

  /** Number of registered targets. */
  get size(): number {
    return this.inner.size;
  }

  /** Remove all targets from the registry. */
  clear(): void {
    this.inner.clear();
  }
}
