// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
/**
 * @fileoverview Enforce use of centralized crypto module
 */

import { logger } from '@opensip-tools/core';
import {
  createPathMatcher,
  defineCheck,
  isCommentLine,
  type CheckViolation,
} from '@opensip-tools/fitness';

/**
 * Pattern configuration for detecting direct crypto usage
 */
interface CryptoPattern {
  regex: RegExp;
  message: string;
  suggestion: string;
  severity: 'error' | 'warning';
}

/**
 * Creates a crypto pattern with standard RegExp
 * Using RegExp constructor avoids sonarjs/regular-expr warnings on literal regex
 * @param pattern - Pattern string to match
 * @param message - Error message to display
 * @param suggestion - Suggested fix
 * @param severity - Severity level
 * @returns Pattern configuration object
 */
function createCryptoPattern(
  pattern: string,
  message: string,
  suggestion: string,
  severity: 'error' | 'warning',
): CryptoPattern {
  // @fitness-ignore-next-line semgrep-scan -- non-literal RegExp is intentional; patterns are hardcoded string constants for code analysis, not user input
  return { regex: new RegExp(pattern, 'g'), message, suggestion, severity };
}

// Patterns indicating direct crypto usage
const DIRECT_CRYPTO_PATTERNS: CryptoPattern[] = [
  // Node.js crypto module - symmetric/hashing
  createCryptoPattern(
    String.raw`crypto\.createHash\s*\(`,
    'Direct crypto.createHash usage - use hashingService.sha256() from crypto module',
    'Use a centralized crypto utility instead of direct crypto.createHash calls.',
    'error',
  ),
  createCryptoPattern(
    String.raw`crypto\.createHmac\s*\(`,
    'Direct crypto.createHmac usage - use hashingService.hmac() from crypto module',
    'Use a centralized crypto utility instead of direct crypto.createHmac calls.',
    'error',
  ),
  createCryptoPattern(
    String.raw`crypto\.createCipheriv\s*\(`,
    'Direct crypto.createCipheriv usage - use encryptionService.encrypt() from crypto module',
    'Use a centralized crypto utility for encryption instead of direct crypto.createCipheriv calls.',
    'error',
  ),
  createCryptoPattern(
    String.raw`crypto\.createDecipheriv\s*\(`,
    'Direct crypto.createDecipheriv usage - use encryptionService.decrypt() from crypto module',
    'Use a centralized crypto utility for decryption instead of direct crypto.createDecipheriv calls.',
    'error',
  ),
  createCryptoPattern(
    String.raw`crypto\.pbkdf2(?:Sync)?\s*\(`,
    'Direct crypto.pbkdf2 usage - use deriveKeyPbkdf2() from crypto module',
    'Use a centralized crypto utility for key derivation instead of direct crypto.pbkdf2 calls.',
    'error',
  ),
  createCryptoPattern(
    String.raw`crypto\.scrypt(?:Sync)?\s*\(`,
    'Direct crypto.scrypt usage - use deriveKeyScrypt() from crypto module',
    'Use a centralized crypto utility for key derivation instead of direct crypto.scrypt calls.',
    'error',
  ),
  // Node.js crypto module - asymmetric signing
  createCryptoPattern(
    String.raw`crypto\.createSign\s*\(`,
    'Direct crypto.createSign usage - use signingService.sign() from crypto module',
    'Use a centralized crypto utility for signing instead of direct crypto.createSign calls.',
    'error',
  ),
  // @fitness-ignore-next-line jwt-validation -- Fitness check definition, not production code; .verify() in suggestion text
  createCryptoPattern(
    String.raw`crypto\.createVerify\s*\(`,
    'Direct crypto.createVerify usage - use signingService.verify() from crypto module',
    'Use a centralized crypto utility for signature verification instead of direct crypto.createVerify calls.',
    'error',
  ),
  createCryptoPattern(
    String.raw`crypto\.sign\s*\(`,
    'Direct crypto.sign usage - use signingService.sign() from crypto module',
    'Use a centralized crypto utility for signing instead of direct crypto.sign calls.',
    'error',
  ),
  // @fitness-ignore-next-line jwt-validation -- Fitness check definition, not production code; .verify() in suggestion text
  createCryptoPattern(
    String.raw`crypto\.verify\s*\(`,
    'Direct crypto.verify usage - use signingService.verify() from crypto module',
    'Use a centralized crypto utility for signature verification instead of direct crypto.verify calls.',
    'error',
  ),
  // Direct createHmac import usage
  createCryptoPattern(
    String.raw`\bcreateHmac\s*\(\s*['"]sha256['"]`,
    'Direct createHmac usage - use hashingService.hmac() from crypto module',
    'Use a centralized crypto utility instead of direct createHmac calls.',
    'error',
  ),
  // AWS KMS direct imports
  createCryptoPattern(
    '@aws-sdk/client-kms',
    'Direct AWS KMS SDK import - use a centralized crypto utility with KMS provider',
    'Use a centralized crypto utility that handles KMS integration for key management.',
    'error',
  ),
  createCryptoPattern(
    String.raw`new KMSClient\s*\(`,
    'Direct KMSClient usage - use a centralized crypto utility with KMS provider',
    'Use a centralized crypto utility that handles KMS integration for key management.',
    'error',
  ),
  // bcrypt/argon2 direct imports
  createCryptoPattern(
    'from [\'"]bcrypt[\'"]',
    'Direct bcrypt import - use hashingService.hashPassword() from crypto module',
    'Use a centralized crypto utility for password hashing instead of direct bcrypt calls.',
    'error',
  ),
  createCryptoPattern(
    'from [\'"]argon2[\'"]',
    'Direct argon2 import - use hashingService.hashPassword() from crypto module',
    'Use a centralized crypto utility for password hashing instead of direct argon2 calls.',
    'error',
  ),
  // Direct jose imports (should use ISigningService wrapper)
  createCryptoPattern(
    'from [\'"]jose[\'"]',
    'Direct jose import - use ISigningService from crypto module',
    'Use a centralized crypto utility for JWT operations instead of direct jose imports.',
    'warning',
  ),
  createCryptoPattern(
    String.raw`import\s+\*\s+as\s+jose\s+from`,
    'Direct jose import - use ISigningService from crypto module',
    'Use a centralized crypto utility for JWT operations instead of direct jose imports.',
    'warning',
  ),
];

// Paths to exclude from checking
const CRYPTO_IMPL_PATTERNS = [
  // The crypto module itself (matches /infrastructure/src/crypto/)
  '/crypto/adapters/',
  '/crypto/core/',
  '/crypto/interfaces/',
  '/crypto/types/',
  // Foundation modules may use crypto primitives
  '/foundation/',
  // Security JWT module uses jose for JWT-specific operations
  '/security/implementations/jwt/',
  // Cognito provider uses jose for AWS Cognito-specific JWT validation
  '/security/providers/cognito/',
  // Webhook verifiers implement provider-specific signature algorithms
  '/webhooks/verifiers/',
  // Fitness check definitions contain pattern strings, not actual crypto usage
  '/fitness/src/checks/',
];

const isExcludedCryptoPath = createPathMatcher(CRYPTO_IMPL_PATTERNS);

/**
 * Check: security/use-centralized-crypto
 *
 * Enforces that services use a centralized crypto utility instead of directly
 * using Node.js crypto, AWS KMS SDK, or other crypto libraries.
 */
export const useCentralizedCrypto = defineCheck({
  id: '38c350d5-1605-4d02-811c-c76261bcbba4',
  slug: 'use-centralized-crypto',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Enforce use of centralized crypto module instead of direct crypto operations',
  longDescription: `**Purpose:** Enforces that services use a centralized crypto utility instead of directly calling Node.js crypto, AWS KMS, or third-party crypto libraries.

**Detects:**
- Direct Node.js crypto calls: \`crypto.createHash\`, \`crypto.createHmac\`, \`crypto.createCipheriv\`, \`crypto.createDecipheriv\`, \`crypto.pbkdf2\`, \`crypto.scrypt\`, \`crypto.createSign\`, \`crypto.createVerify\`, \`crypto.sign\`, \`crypto.verify\`
- Direct \`createHmac('sha256', ...)\` usage
- AWS KMS direct imports: \`@aws-sdk/client-kms\`, \`new KMSClient()\`
- Direct password hashing imports: \`from 'bcrypt'\`, \`from 'argon2'\`
- Direct JOSE imports: \`from 'jose'\`, \`import * as jose\`

**Why it matters:** Centralized crypto ensures consistent algorithm choices, key management, and makes it possible to audit or rotate cryptographic operations from a single location.

**Scope:** Codebase-specific convention. Analyzes each file individually. Excludes the crypto module itself, foundation, security JWT, Cognito provider, webhook verifiers, and fitness check definitions.`,
  tags: ['security', 'crypto', 'centralization', 'best-practices'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    logger.debug({
      evt: 'fitness.checks.centralized_crypto.analyze',
      msg: 'Analyzing file for direct crypto usage',
    });
    if (isExcludedCryptoPath(filePath)) {
      return [];
    }

    const violations: CheckViolation[] = [];
    const lines = content.split('\n');

    for (const [lineNum, line_] of lines.entries()) {
      const line = line_ ?? '';

      if (isCommentLine(line)) {
        continue;
      }

      for (const pattern of DIRECT_CRYPTO_PATTERNS) {
        pattern.regex.lastIndex = 0;
        const match = pattern.regex.exec(line);
        if (match) {
          violations.push({
            line: lineNum + 1,
            column: match.index,
            message: pattern.message,
            severity: pattern.severity,
            suggestion: pattern.suggestion,
            match: match[0],
            filePath,
          });
        }
      }
    }

    return violations;
  },
});
