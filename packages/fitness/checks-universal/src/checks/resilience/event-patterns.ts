// @fitness-ignore-file no-custom-event-emitter -- Fitness check definition contains EventEmitter pattern strings for detection, not actual usage
// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
/**
 * @fileoverview Event handling resilience checks
 */

import { logger } from '@opensip-tools/core/logger'
import { defineCheck, type CheckViolation, getLineNumber } from '@opensip-tools/fitness'

// =============================================================================
// EVENT ARCHITECTURE
// =============================================================================

/**
 * Patterns indicating event handlers.
 * Using bounded quantifiers to avoid regex backtracking.
 */
const EVENT_HANDLER_PATTERNS = [
  /@EventHandler/,
  /EventHandler/i,
  /\.subscribe\s{0,10}\(/,
  /\.addListener\s{0,10}\(/,
]

/**
 * Patterns indicating proper event handling
 */
const PROPER_EVENT_PATTERNS = [
  /eventBus/i,
  /eventEmitter/i,
  /infrastructure\/events/,
  /EventPublisher/i,
]

/**
 * Patterns indicating idempotency handling.
 *
 * Includes domain-specific delivery-id keys used by upstream dispatchers
 * (GitHub webhooks: `deliveryId`; AWS SQS: `messageId`; Stripe: `eventId`)
 * — when a handler references one of these, the upstream framework is
 * deduplicating on it before invoking the handler.
 */
const IDEMPOTENCY_PATTERNS = [
  /idempotency/i,
  /dedup/i,
  /idempotentId/i,
  /messageId/i,
  /deliveryId/i,
  /eventId/i,
  /processedEvents/i,
  /alreadyProcessed/i,
]

/**
 * Patterns indicating state-changing operations that need idempotency
 */
const STATE_CHANGING_PATTERNS = [
  /\.save\s*\(/,
  /\.update\s*\(/,
  /\.create\s*\(/,
  /\.insert\s*\(/,
  /\.delete\s*\(/,
  /transaction/i,
]

/**
 * Check if content has direct EventEmitter usage.
 * @param line - Line to check.
 * @returns True if line has direct EventEmitter pattern.
 */
function hasDirectEventEmitterPattern(line: string): boolean {
  logger.debug({
    evt: 'fitness.checks.event_patterns.has_direct_event_emitter_pattern',
    msg: 'Checking line for direct EventEmitter pattern',
  })
  // Check for "new EventEmitter("
  if (line.includes('new EventEmitter(') || line.includes('new EventEmitter (')) {
    return true
  }

  // Check for ".emit('event'" or '.emit("event"'
  const emitIdx = line.indexOf('.emit(')
  if (emitIdx === -1) {
    return false
  }
  const afterEmit = line.slice(emitIdx + 6).trimStart()
  return afterEmit.startsWith("'") || afterEmit.startsWith('"')
}

/**
 * Finds the first event handler pattern match in content.
 */
function findFirstEventHandlerMatch(content: string): RegExpExecArray | null {
  logger.debug({
    evt: 'fitness.checks.event_patterns.find_first_event_handler_match',
    msg: 'Searching for first event handler pattern match',
  })
  for (const pattern of EVENT_HANDLER_PATTERNS) {
    pattern.lastIndex = 0
    const match = pattern.exec(content)
    if (match) {
      return match
    }
  }
  return null
}

/**
 * Check: resilience/event-architecture
 *
 * Validates event handling follows architectural patterns:
 * - Using canonical event bus from infrastructure
 * - Not creating custom EventEmitters in domain code
 * - Events have proper schemas
 */
export const eventArchitecture = defineCheck({
  id: 'd187e10a-fca8-46e5-9ce7-23a5175ba446',
  slug: 'event-architecture',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Validate event handling follows architectural patterns',
  longDescription: `**Purpose:** Enforces use of the canonical infrastructure EventBus instead of direct \`EventEmitter\` usage in domain code.

**Detects:**
- \`new EventEmitter(\` instantiation
- \`.emit(\` calls followed by a string literal (quoted event name)
- Skips files that reference proper infrastructure patterns: \`eventBus\`, \`eventEmitter\` (as import), \`infrastructure/events\`, \`EventPublisher\`

**Why it matters:** Direct EventEmitter usage bypasses schema validation, observability, and cross-service event routing provided by the infrastructure event bus.

**Scope:** Codebase-specific convention. Analyzes each file individually via string matching.`,
  tags: ['resilience', 'architecture', 'events'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    logger.debug({
      evt: 'fitness.checks.event_patterns.analyze_event_architecture',
      msg: 'Analyzing file for event architecture pattern violations',
    })
    const violations: CheckViolation[] = []

    // Skip files that don't have event patterns
    if (!content.includes('emit') && !content.includes('EventEmitter')) {
      return violations
    }

    // Skip if file uses proper infrastructure patterns
    const usesProperPatterns = PROPER_EVENT_PATTERNS.some((p) => p.test(content))
    if (usesProperPatterns) {
      return violations
    }

    // Check each line for direct EventEmitter usage
    const lines = content.split('\n')
    for (const [i, line] of lines.entries()) {
      if (!line || !hasDirectEventEmitterPattern(line)) {
        continue
      }

      const lineNumber = i + 1
      violations.push({
        line: lineNumber,
        column: 0,
        message: 'Direct EventEmitter usage bypasses infrastructure event bus',
        severity: 'warning',
        suggestion:
          'Use a centralized event bus instead. Example: eventBus.publish("event.name", payload) for consistent event handling, schema validation, and observability.',
        match: line.trim().slice(0, 50),
        type: 'direct-event-emitter',
        filePath,
      })
    }

    return violations
  },
})

// =============================================================================
// EVENT HANDLER IDEMPOTENCY
// =============================================================================

/**
 * Check: resilience/event-handler-idempotency
 *
 * Validates event handlers implement idempotency for at-least-once delivery:
 * - Checking for duplicate message processing
 * - Using idempotent operations
 */
export const eventHandlerIdempotency = defineCheck({
  id: '78c29f34-4274-4713-b51e-3fb1694dccdb',
  slug: 'event-handler-idempotency',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  description: 'Validate event handlers implement idempotency',
  longDescription: `**Purpose:** Ensures event handlers that perform state-changing operations include idempotency safeguards for at-least-once delivery.

**Detects:**
- Files containing event handler indicators (\`@EventHandler\`, \`.subscribe(\`, \`.addListener(\`) with state-changing operations (\`.save(\`, \`.update(\`, \`.create(\`, \`.insert(\`, \`.delete(\`, \`transaction\`)
- Flags when no idempotency patterns are present: \`idempotency\`, \`dedup\`, \`idempotentId\`, \`messageId\`, \`processedEvents\`, \`alreadyProcessed\`

**Why it matters:** Without idempotency checks, duplicate event delivery causes repeated writes, double charges, or corrupted state.

**Scope:** General best practice. Analyzes each file individually via regex.`,
  tags: ['resilience', 'events', 'idempotency'],

  analyze(content: string, filePath: string): CheckViolation[] {
    logger.debug({
      evt: 'fitness.checks.event_patterns.analyze_event_handler_idempotency',
      msg: 'Analyzing file for event handler idempotency',
    })
    const violations: CheckViolation[] = []

    // Check if this is an event handler file
    const isEventHandler = EVENT_HANDLER_PATTERNS.some((p) => p.test(content))
    if (!isEventHandler) {
      return violations
    }

    // Check if file has state-changing operations
    const hasStateChanges = STATE_CHANGING_PATTERNS.some((p) => p.test(content))
    if (!hasStateChanges) {
      return violations
    }

    // Check for idempotency handling
    const hasIdempotency = IDEMPOTENCY_PATTERNS.some((p) => p.test(content))
    if (hasIdempotency) {
      return violations
    }

    // Find the handler definition for line number
    const match = findFirstEventHandlerMatch(content)
    if (!match) {
      return violations
    }

    const lineNumber = getLineNumber(content, match.index)
    violations.push({
      line: lineNumber,
      column: 0,
      message: 'Event handler with state changes may not be idempotent',
      severity: 'warning',
      suggestion:
        'Add idempotency check (deduplication) for at-least-once delivery. Use event.idempotencyKey or event.messageId to track processed events and skip duplicates.',
      match: match[0],
      type: 'non-idempotent-handler',
      filePath,
    })

    return violations
  },
})
