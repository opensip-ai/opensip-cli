// Clean: the ADR-0023-exempt run-scoped memoryProfiler singleton — allowlisted.
export const memoryProfiler = new MemoryProfiler()
declare class MemoryProfiler {}
