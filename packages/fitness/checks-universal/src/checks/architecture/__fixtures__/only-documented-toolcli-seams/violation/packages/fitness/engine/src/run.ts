// Violation: a tool engine that bypasses the ToolCliContext seams — it writes
// run output straight to stdout and constructs its own datastore instead of
// reading scope.datastore().
import { DataStoreFactory } from '@opensip-cli/datastore';

export function run(): void {
  const store = DataStoreFactory.open({ backend: 'memory' });
  process.stdout.write(JSON.stringify({ ok: true, store: store !== undefined }) + '\n');
}
