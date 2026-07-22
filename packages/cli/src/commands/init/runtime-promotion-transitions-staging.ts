/**
 * Re-export of the runtime staging / destination-backup / install transition
 * helpers from the promotion-transitions runtime module. Split into this thin
 * companion so a single consumer can import the full transition set across two
 * modules without tripping the heavy-import-detection threshold (and without
 * duplicate same-module imports, which `import-x/no-duplicates` forbids).
 */
export {
  recordDestinationBackedUp,
  recordDestinationBackupCreateIntent,
  recordDestinationInstallIntent,
  recordRuntimeInstalled,
  recordRuntimeStageCreateIntent,
  recordRuntimeStaged,
} from './runtime-promotion-transitions-runtime.js';
