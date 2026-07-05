// FIXTURE — CLEAN (no-module-singleton).
class MemoryProfiler {}

export function createMemoryProfiler(): MemoryProfiler {
  return new MemoryProfiler();
}
