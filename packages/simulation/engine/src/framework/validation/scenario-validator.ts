// @fitness-ignore-file file-length-limits -- Validator covers all scenario config fields with detailed error messages; splitting would fragment validation logic
/**
 * @fileoverview Scenario Validator
 *
 * Validates scenario definitions to catch configuration errors early.
 */

import type {
  SimulationScenario,
  PersonaConfig,
  ScenarioAssertion,
  ChaosConfig,
} from '../../types/base-types.js'

// =============================================================================
// TYPES
// =============================================================================

/** A single validation error or warning for a scenario field */
export interface ScenarioValidationError {
  field: string
  message: string
  severity: 'error' | 'warning'
}

/** Aggregated validation result for a scenario, with separate error and warning lists */
export interface ScenarioValidationResult {
  valid: boolean
  errors: ScenarioValidationError[]
  warnings: ScenarioValidationError[]
}

// =============================================================================
// CONSTANTS
// =============================================================================

const VALID_SCENARIO_TYPES = new Set([
  'happy-path',
  'edge-case',
  'error-injection',
  'load',
  'load-test',
  'chaos',
])

const VALID_OPERATORS = new Set(['lt', 'lte', 'gt', 'gte', 'eq', 'neq'])

const VALID_METRICS = new Set([
  'error_rate',
  'success_rate',
  'recovery_rate',
  'p50_latency',
  'p50_latency_ms',
  'p95_latency',
  'p95_latency_ms',
  'p99_latency',
  'p99_latency_ms',
  'avg_latency',
  'avg_latency_ms',
  'max_latency_ms',
  'total_requests',
  'failed_requests',
  'findings_generated',
])

const VALID_CHAOS_TYPES = new Set([
  'latency',
  'error',
  'timeout',
  'rate-limit',
  'connection-drop',
  'data-corruption',
])

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

interface ValidationAccumulator {
  errors: ScenarioValidationError[]
  warnings: ScenarioValidationError[]
}

function addValidationResults(
  acc: ValidationAccumulator,
  results: ScenarioValidationError[],
): void {
  if (!Array.isArray(results)) return

  for (const result of results) {
    if (result.severity === 'error') {
      acc.errors.push(result)
    } else {
      acc.warnings.push(result)
    }
  }
}

function validateScenarioId(id: unknown): ScenarioValidationError[] {
  if (!id || typeof id !== 'string') {
    return [
      { field: 'id', message: 'Scenario ID is required and must be a string', severity: 'error' },
    ]
  }
  if (!/^[a-z0-9-]+$/.test(id)) {
    return [
      {
        field: 'id',
        message: 'Scenario ID should be kebab-case (lowercase with hyphens)',
        severity: 'warning',
      },
    ]
  }
  return []
}

function validateScenarioType(type: unknown): ScenarioValidationError[] {
  if (!type) {
    return [{ field: 'type', message: 'Scenario type is required', severity: 'error' }]
  }
  if (!VALID_SCENARIO_TYPES.has(type as string)) {
    const typeStr = typeof type === 'string' ? type : JSON.stringify(type)
    return [
      {
        field: 'type',
        message: `Unknown scenario type "${typeStr}". Valid types: ${[...VALID_SCENARIO_TYPES].join(', ')}`,
        severity: 'warning',
      },
    ]
  }
  return []
}

function validateTiming(duration: number, rampUp: number): ScenarioValidationError[] {
  const results: ScenarioValidationError[] = []

  if (typeof duration !== 'number' || duration <= 0) {
    results.push({
      field: 'duration',
      message: 'Duration must be a positive number (in seconds)',
      severity: 'error',
    })
  } else if (duration > 3600) {
    results.push({
      field: 'duration',
      message: 'Duration exceeds 1 hour - consider if this is intentional',
      severity: 'warning',
    })
  }

  if (typeof rampUp !== 'number' || rampUp < 0) {
    results.push({
      field: 'rampUp',
      message: 'Ramp-up must be a non-negative number (in seconds)',
      severity: 'error',
    })
  } else if (rampUp > duration) {
    results.push({ field: 'rampUp', message: 'Ramp-up time exceeds duration', severity: 'warning' })
  }

  return results
}

function validateTargetRps(targetRps: number): ScenarioValidationError[] {
  if (typeof targetRps !== 'number' || targetRps <= 0) {
    return [
      { field: 'targetRps', message: 'Target RPS must be a positive number', severity: 'error' },
    ]
  }
  if (targetRps > 1000) {
    return [
      {
        field: 'targetRps',
        message: 'Target RPS exceeds 1000 - ensure infrastructure can handle this load',
        severity: 'warning',
      },
    ]
  }
  return []
}

function validatePersonaConfig(config: PersonaConfig, index: number): ScenarioValidationError[] {
  const errors: ScenarioValidationError[] = []
  const prefix = `personas[${index}]`

  if (!config.personaId || typeof config.personaId !== 'string') {
    errors.push({
      field: `${prefix}.personaId`,
      message: 'Persona ID is required',
      severity: 'error',
    })
  }

  if (typeof config.count !== 'number' || config.count <= 0) {
    errors.push({
      field: `${prefix}.count`,
      message: 'Persona count must be a positive number',
      severity: 'error',
    })
  }

  if (typeof config.spawnRate !== 'number' || config.spawnRate <= 0) {
    errors.push({
      field: `${prefix}.spawnRate`,
      message: 'Spawn rate must be a positive number',
      severity: 'error',
    })
  }

  if (!Array.isArray(config.actions) || config.actions.length === 0) {
    errors.push({
      field: `${prefix}.actions`,
      message: 'Actions must be a non-empty array',
      severity: 'error',
    })
  }

  return errors
}

function validatePersonas(personas: PersonaConfig[]): ScenarioValidationError[] {
  if (!Array.isArray(personas) || personas.length === 0) {
    return [
      {
        field: 'personas',
        message: 'At least one persona configuration is required',
        severity: 'error',
      },
    ]
  }
  const results: ScenarioValidationError[] = []
  personas.forEach((persona, index) => {
    results.push(...validatePersonaConfig(persona, index))
  })
  return results
}

function validateAssertion(assertion: ScenarioAssertion, index: number): ScenarioValidationError[] {
  const errors: ScenarioValidationError[] = []
  const prefix = `assertions[${index}]`

  if (!assertion.metric || typeof assertion.metric !== 'string') {
    errors.push({
      field: `${prefix}.metric`,
      message: 'Assertion metric is required',
      severity: 'error',
    })
  } else if (!VALID_METRICS.has(assertion.metric)) {
    errors.push({
      field: `${prefix}.metric`,
      message: `Unknown metric "${assertion.metric}". Valid metrics: ${[...VALID_METRICS].join(', ')}`,
      severity: 'warning',
    })
  }

  if (!VALID_OPERATORS.has(assertion.operator)) {
    errors.push({
      field: `${prefix}.operator`,
      message: `Invalid operator "${assertion.operator}". Valid operators: ${[...VALID_OPERATORS].join(', ')}`,
      severity: 'error',
    })
  }

  if (typeof assertion.value !== 'number') {
    errors.push({
      field: `${prefix}.value`,
      message: 'Assertion value must be a number',
      severity: 'error',
    })
  }

  if (!assertion.message || typeof assertion.message !== 'string') {
    errors.push({
      field: `${prefix}.message`,
      message: 'Assertion should have a descriptive message',
      severity: 'warning',
    })
  }

  return errors
}

function validateAssertions(assertions: ScenarioAssertion[]): ScenarioValidationError[] {
  if (!Array.isArray(assertions)) {
    return [{ field: 'assertions', message: 'Assertions must be an array', severity: 'error' }]
  }
  if (assertions.length === 0) {
    return [
      {
        field: 'assertions',
        message: 'No assertions defined - consider adding success criteria',
        severity: 'warning',
      },
    ]
  }
  const results: ScenarioValidationError[] = []
  assertions.forEach((assertion, index) => {
    results.push(...validateAssertion(assertion, index))
  })
  return results
}

// @fitness-ignore-next-line file-length-limits -- Validation function: sequential field-by-field validation of chaos config with specific error messages per field
function validateChaosConfig(config: ChaosConfig): ScenarioValidationError[] {
  const errors: ScenarioValidationError[] = []
  const prefix = 'chaosConfig'

  if (typeof config.enabled !== 'boolean') {
    errors.push({
      field: `${prefix}.enabled`,
      message: 'Chaos enabled must be a boolean',
      severity: 'error',
    })
  }

  if (typeof config.probability !== 'number' || config.probability < 0 || config.probability > 1) {
    errors.push({
      field: `${prefix}.probability`,
      message: 'Chaos probability must be between 0 and 1',
      severity: 'error',
    })
  }

  if (Array.isArray(config.types)) {
    config.types.forEach((injection, index) => {
      if (!VALID_CHAOS_TYPES.has(injection.type)) {
        errors.push({
          field: `${prefix}.types[${index}].type`,
          message: `Unknown chaos type "${injection.type}". Valid types: ${[...VALID_CHAOS_TYPES].join(', ')}`,
          severity: 'error',
        })
      }

      if (
        typeof injection.probability !== 'number' ||
        injection.probability < 0 ||
        injection.probability > 1
      ) {
        errors.push({
          field: `${prefix}.types[${index}].probability`,
          message: 'Injection probability must be between 0 and 1',
          severity: 'error',
        })
      }

      if (!injection.target || typeof injection.target !== 'string') {
        errors.push({
          field: `${prefix}.types[${index}].target`,
          message: 'Injection target is required',
          severity: 'error',
        })
      }
    })
  } else {
    errors.push({
      field: `${prefix}.types`,
      message: 'Chaos types must be an array',
      severity: 'error',
    })
  }

  return errors
}

// =============================================================================
// MAIN VALIDATION
// =============================================================================

/**
 * Validate a scenario definition.
 */
export function validateScenario(scenario: SimulationScenario): ScenarioValidationResult {
  const acc: ValidationAccumulator = { errors: [], warnings: [] }

  addValidationResults(acc, validateScenarioId(scenario.id))

  if (!scenario.name || typeof scenario.name !== 'string') {
    acc.errors.push({
      field: 'name',
      message: 'Scenario name is required and must be a string',
      severity: 'error',
    })
  }

  if (!scenario.description || typeof scenario.description !== 'string') {
    acc.warnings.push({
      field: 'description',
      message: 'Scenario description should be provided',
      severity: 'warning',
    })
  }

  addValidationResults(acc, validateScenarioType(scenario.type))
  addValidationResults(acc, validateTiming(scenario.duration, scenario.rampUp))
  addValidationResults(acc, validateTargetRps(scenario.targetRps))
  addValidationResults(acc, validatePersonas(scenario.personas))
  addValidationResults(acc, validateAssertions(scenario.assertions))

  if (!Array.isArray(scenario.tags)) {
    acc.errors.push({ field: 'tags', message: 'Tags must be an array', severity: 'error' })
  }

  if (scenario.chaosConfig) {
    addValidationResults(acc, validateChaosConfig(scenario.chaosConfig))
  }

  return {
    valid: acc.errors.length === 0,
    errors: acc.errors,
    warnings: acc.warnings,
  }
}

/**
 * Validate multiple scenarios and return aggregated results.
 */
export function validateScenarios(scenarios: SimulationScenario[]): {
  valid: boolean
  results: Map<string, ScenarioValidationResult>
  totalErrors: number
  totalWarnings: number
} {
  const results = new Map<string, ScenarioValidationResult>()
  let totalErrors = 0
  let totalWarnings = 0

  for (const scenario of scenarios) {
    const result = validateScenario(scenario)
    results.set(scenario.id, result)
    totalErrors += result.errors.length
    totalWarnings += result.warnings.length
  }

  return {
    valid: totalErrors === 0,
    results,
    totalErrors,
    totalWarnings,
  }
}

/**
 * Format validation result for display.
 */
export function formatScenarioValidationResult(
  scenarioId: string,
  result: ScenarioValidationResult,
): string {
  const lines: string[] = []

  if (result.valid && result.warnings.length === 0) {
    lines.push(`PASS ${scenarioId}: Valid`)
  } else if (result.valid) {
    lines.push(`WARN ${scenarioId}: Valid with ${result.warnings.length} warning(s)`)
  } else {
    lines.push(
      `FAIL ${scenarioId}: Invalid - ${result.errors.length} error(s), ${result.warnings.length} warning(s)`,
    )
  }

  for (const error of result.errors) {
    lines.push(`  ERROR: ${error.field} - ${error.message}`)
  }

  for (const warning of result.warnings) {
    lines.push(`  WARN:  ${warning.field} - ${warning.message}`)
  }

  return lines.join('\n')
}
