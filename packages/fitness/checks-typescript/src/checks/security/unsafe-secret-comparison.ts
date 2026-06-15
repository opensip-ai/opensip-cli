/**
 * @fileoverview Detect unsafe equality comparisons on secret/token values
 *
 * Finds binary equality operators (=== / !==) applied to variables whose names
 * suggest they hold cryptographic secrets (token, secret, signature, password,
 * key). Such comparisons are vulnerable to timing attacks and must use a
 * constant-time comparison function like safeCompare().
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';
import {
  parseSource,
  walkNodes,
  getIdentifierName,
  isLiteral,
  isPropertyAccess,
  getLineNumber,
} from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

/**
 * Identifier patterns that indicate a secret value.
 *
 * Two heuristics work together:
 *
 *   1. **Standalone match** — the whole identifier (case-insensitive)
 *      is an unambiguously secret-bearing name from
 *      `STANDALONE_SECRET_NAMES`.
 *
 *   2. **Compound CamelCase match** — the identifier splits into a
 *      `<securityPrefix><CamelSuffix>` shape where the prefix is in
 *      `SECRET_PREFIXES` and the trailing CamelCase noun ends with a
 *      word in `SECRET_SUFFIXES` (e.g., `apiKey`, `passwordHash`,
 *      `webhookSignature`).
 *
 * The earlier broad substring heuristic (`/secret|token|key|hash|.../i`)
 * was retired because it over-fired on content-identity / cache /
 * dedup variables like `cacheKey`, `bodyHash`, `ownerHash`,
 * `contentHash`, `mapKey` — none of which are security boundaries
 * (both sides are locally computed; no attacker timing channel). For
 * the cases the tighter heuristic misses, mark the suspect site with
 * `// @fitness-ignore-next-line unsafe-secret-comparison -- <reason>`
 * (false positive) or refactor to `crypto.timingSafeEqual()` (real
 * secret comparison).
 *
 * Sets are used instead of one big regex because the alternation
 * count was tripping `sonarjs/regex-complexity` (≤ 20 alternatives).
 */
const STANDALONE_SECRET_NAMES: ReadonlySet<string> = new Set([
  'secret',
  'password',
  'token',
  'signature',
  'jwt',
  'hmac',
  'bearer',
  'sessionid',
  'csrftoken',
  'sessiontoken',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'bearertoken',
  'apikey',
  'apitoken',
  'apisecret',
  'signingkey',
  'encryptionkey',
  'privatekey',
  'publickey',
  'secretkey',
  'hmackey',
  'cookiesecret',
  'webhooksignature',
  'paymentsignature',
  'passwordhash',
  'authtoken',
]);

const SECRET_PREFIXES: ReadonlySet<string> = new Set([
  'secret',
  'api',
  'access',
  'refresh',
  'id',
  'bearer',
  'csrf',
  'session',
  'signing',
  'encryption',
  'private',
  'public',
  'password',
  'jwt',
  'oauth',
  'auth',
  'cookie',
  'webhook',
  'payment',
  'hmac',
  'otp',
  'mfa',
]);

const SECRET_SUFFIXES: ReadonlySet<string> = new Set([
  'Key',
  'Token',
  'Secret',
  'Hash',
  'Hmac',
  'Digest',
  'Signature',
  'Code',
  'Cookie',
]);

/** Split `apiKey` → `['api', 'Key']`; `accessRefreshToken` → `['access', 'Refresh', 'Token']`. */
const CAMEL_SPLIT_PATTERN = /(?=[A-Z])/;

function looksLikeSecret(name: string): boolean {
  if (!name) return false;
  if (STANDALONE_SECRET_NAMES.has(name.toLowerCase())) return true;
  // Compound: first word is a security prefix; final word is a sensitive suffix.
  const parts = name.split(CAMEL_SPLIT_PATTERN);
  const last = parts.at(-1);
  return (
    parts.length >= 2 &&
    SECRET_PREFIXES.has(parts[0]) &&
    last !== undefined &&
    SECRET_SUFFIXES.has(last)
  );
}

/**
 * Names that look like secrets but are actually safe to compare with ===.
 * E.g. `key.length`, `token !== undefined`, `tokenType === 'bearer'`.
 */
const SAFE_COMPARAND_PATTERNS = [/^undefined$/, /^null$/, /^true$/, /^false$/];

/** Properties that don't carry secret data */
const SAFE_PROPERTY_NAMES = ['length', 'type', 'status', 'kind', 'name', 'id', 'count', 'size'];

/**
 * Check if a comparand is a literal value or safe property access,
 * which would make the comparison safe (not comparing two secret values).
 */
function isLiteralOrSafe(node: ts.Node): boolean {
  if (isLiteral(node)) return true;
  /* v8 ignore next -- defensive AST/type guard */
  if (ts.isTypeOfExpression(node)) return true;
  /* v8 ignore next -- defensive AST/type guard */
  if (SAFE_PROPERTY_NAMES.some((prop) => isPropertyAccess(node, prop))) return true;

  const text = getIdentifierName(node);
  /* v8 ignore next -- defensive AST/type guard */
  if (text && SAFE_COMPARAND_PATTERNS.some((p) => p.test(text))) return true;

  return false;
}

/**
 * Check if either operand has a secret-like name.
 * Returns the secret-bearing operand name for the violation message, or null.
 */
function findSecretOperand(left: ts.Node, right: ts.Node): string | null {
  const leftName = getIdentifierName(left);
  const rightName = getIdentifierName(right);

  const leftIsSecret = looksLikeSecret(leftName);
  const rightIsSecret = looksLikeSecret(rightName);

  if (!leftIsSecret && !rightIsSecret) return null;

  // If one side is secret but the other is a literal/safe value, skip
  if (leftIsSecret && isLiteralOrSafe(right)) return null;
  /* v8 ignore next -- defensive AST/type guard */
  if (rightIsSecret && isLiteralOrSafe(left)) return null;

  /* v8 ignore next -- defensive AST/type guard */
  return leftIsSecret ? leftName : rightName;
}

/**
 * Check: security/unsafe-secret-comparison
 *
 * Detects usage of === or !== to compare variables whose names suggest they
 * hold cryptographic secrets. Such comparisons are vulnerable to timing
 * side-channel attacks.
 */
export const unsafeSecretComparison = defineCheck({
  id: '0249cfc8-5342-480a-a9d0-fbf7ad89a6cf',
  slug: 'unsafe-secret-comparison',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',
  confidence: 'high',
  description: 'Detect timing-unsafe equality comparisons on secret/token values',
  longDescription: `**Purpose:** Detects \`===\` or \`!==\` comparisons on variables whose names suggest they hold cryptographic secrets, which are vulnerable to timing side-channel attacks.

**Detects:**
- Binary expressions using \`===\` or \`!==\` where either operand name matches:
  - **Standalone:** \`secret\`, \`password\`, \`token\`, \`signature\`, \`jwt\`, \`hmac\`, \`bearer\`, \`apiKey\`, \`apiToken\`, \`apiSecret\`, \`accessToken\`, \`refreshToken\`, \`idToken\`, \`bearerToken\`, \`sessionToken\`, \`sessionId\`, \`csrfToken\`, \`signingKey\`, \`encryptionKey\`, \`privateKey\`, \`publicKey\`, \`secretKey\`, \`hmacKey\`, \`cookieSecret\`, \`webhookSignature\`, \`paymentSignature\`, \`passwordHash\`, \`authToken\` (case-insensitive)
  - **Compound CamelCase:** a security-context prefix (\`secret\`, \`api\`, \`access\`, \`refresh\`, \`id\`, \`bearer\`, \`csrf\`, \`session\`, \`signing\`, \`encryption\`, \`private\`, \`public\`, \`password\`, \`jwt\`, \`oauth\`, \`auth\`, \`cookie\`, \`webhook\`, \`payment\`, \`hmac\`, \`otp\`, \`mfa\`) paired with a sensitive-data suffix (\`Key\`, \`Token\`, \`Secret\`, \`Hash\`, \`Hmac\`, \`Digest\`, \`Signature\`, \`Code\`, \`Cookie\`).
- Excludes comparisons against literals, \`undefined\`, \`null\`, \`true\`, \`false\`, \`typeof\`, and safe property accesses (.length, .type, .status, .kind, .name, .id, .count, .size)
- **Does NOT fire on** generic identity / cache / dedup hashes like \`cacheKey\`, \`bodyHash\`, \`ownerHash\`, \`contentHash\`, \`mapKey\` — both sides are locally computed, no attacker timing channel.

**Why it matters:** Standard equality operators short-circuit on the first differing byte, leaking information about how much of a secret value matches. Attackers can reconstruct secrets one byte at a time using timing measurements.

**False negatives:** If you compare a real secret under a name the heuristic doesn't recognize (e.g., a custom domain term), the check will miss it — switching to \`crypto.timingSafeEqual()\` everywhere you compare attacker-influenced values against trusted ones is the durable fix; this check is a tripwire, not a guarantee.

**False positives:** If the check fires on a content-identity variable the heuristic doesn't yet skip, annotate with \`// @fitness-ignore-next-line unsafe-secret-comparison -- <reason>\` (preferred) or rename the variable to make the non-secret intent explicit.

**Scope:** General best practice. Analyzes each file individually using TypeScript AST. Targets auth, middleware, token service, and crypto directories — i.e., wherever the project's targets attach a \`backend\` or \`server\` concern.`,
  tags: ['security', 'timing-attack', 'crypto'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    const sourceFile = parseSource(content, filePath);
    /* v8 ignore next -- defensive guard */
    if (!sourceFile) return [];

    const violations: CheckViolation[] = [];

    walkNodes(sourceFile, (node) => {
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
      ) {
        const secretName = findSecretOperand(node.left, node.right);
        if (secretName) {
          const line = getLineNumber(node, sourceFile);
          const operator =
            node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? '===' : '!==';
          violations.push({
            line,
            column: node.operatorToken.getStart() - node.getStart(),
            message: `Timing-unsafe ${operator} comparison on '${secretName}' — use crypto.timingSafeEqual() (Node.js built-in)`,
            severity: 'error',
            suggestion: `Replace \`a ${operator} b\` with \`${operator === '!==' ? '!' : ''}safeCompare(a, b)\` to prevent timing side-channel attacks.`,
            match: node.getText(),
            filePath,
          });
        }
      }
    });

    return violations;
  },
});
