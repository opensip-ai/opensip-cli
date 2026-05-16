// A small fixture project the catalog builder tests run against.
// Three direct-call functions, one orphan, and one duplicate body.

export function main(): void {
  greet('world');
  unusedHelper();
}

export function greet(name: string): void {
  console.log(`hello ${name}`);
}

export function unusedHelper(): void {
  // Reachable from main only — folded into main's subtree if main is the orphan root.
  return;
}

// Definitely not called from anywhere — this is the canonical orphan.
export function deadCode(): number {
  return 42;
}
