/**
 * @opensip-cli/clone-detection — shared function-body clone-detection substrate.
 *
 * A pure, `node:crypto`-only leaf package (layer 2) that single-sources the body-hash
 * + MinHash primitives, the tool-neutral `CloneCandidate` shape, and the duplicate /
 * near-duplicate detection algorithms + curation policy. Both the graph tool and the
 * yagni tool depend on it (neither on the other), so there is exactly one
 * implementation and they cannot diverge (ADR-0064).
 *
 * Barrel is populated by Tasks 1.2–1.3a.
 */

export {};
