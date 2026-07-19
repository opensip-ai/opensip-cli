import type { RuntimePromotionDatastoreFailureReason } from './runtime-promotion-preflight-datastore-types.js';
import type { DatastoreCloseResult } from '@opensip-cli/datastore';

export class RuntimePromotionDatastoreError extends Error {
  readonly releaseSafe: boolean;

  constructor(
    readonly reason: RuntimePromotionDatastoreFailureReason,
    readonly closeResult?: DatastoreCloseResult,
  ) {
    super(`Runtime promotion datastore preparation failed (${reason}).`);
    this.name = 'RuntimePromotionDatastoreError';
    this.releaseSafe = closeResult?.closed !== false;
  }
}
