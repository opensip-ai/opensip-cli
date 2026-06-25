/**
 * Canonical TypeScript test-file predicate — relocated to the shared
 * `@opensip-cli/clone-detection` substrate (ADR-0064, D1) so graph's TS walk and yagni's
 * TS inventory stamp `inTestFile` from ONE predicate and cannot diverge. Re-exported here
 * (via the graph engine barrel) under the existing name so every caller — `walk.ts`
 * (`inTestFile` stamping) and `index.ts` (`RuleHints.isTestFile`) — is unchanged and the
 * classification is byte-identical.
 */

export { isTestFilePath as isTypescriptTestFile } from '@opensip-cli/graph';
