// Violation fixture: a re-added module-level mutable registry singleton — the
// exact thing Phase 3 deleted. Must flag.
export const defaultRegistry = new CheckRegistry()

declare class CheckRegistry {}
