/**
 * Minimal target types for scope resolution.
 * Minimal target types for scope resolution.
 */

export interface Target {
  readonly name: string
  readonly languages: readonly string[]
  readonly concerns: readonly string[]
  readonly include: readonly string[]
  readonly exclude: readonly string[]
}

export interface TargetsConfig {
  readonly globalExcludes: readonly string[]
  readonly targets: readonly Target[]
  /** Per-check overrides: slug → target name(s) */
  readonly checkOverrides: Record<string, string | readonly string[]>
}

export class TargetRegistry {
  private readonly targets: Target[]
  private readonly globalExcludes: readonly string[]

  constructor(config: TargetsConfig) {
    this.targets = [...config.targets]
    this.globalExcludes = config.globalExcludes
  }

  findByScope(languages: readonly string[], concerns: readonly string[]): Target[] {
    return this.targets.filter(t =>
      languages.some(l => t.languages.includes(l)) &&
      (concerns.length === 0 || concerns.some(c => t.concerns.includes(c)))
    )
  }

  getByName(name: string): Target | undefined {
    return this.targets.find(t => t.name === name)
  }

  getAll(): Target[] {
    return [...this.targets]
  }

  getGlobalExcludes(): readonly string[] {
    return this.globalExcludes
  }

  list(): readonly Target[] {
    return this.targets
  }
}
