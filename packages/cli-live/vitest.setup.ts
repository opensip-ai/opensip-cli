import { Console } from 'node:console';

// Vitest's default console stub omits `Console`; Ink's patch-console needs it.
if (typeof console.Console !== 'function') {
  Object.assign(console, { Console });
}
