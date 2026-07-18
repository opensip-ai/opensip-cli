export type RuntimePromotionPreflightFailureReason = 'lease-mismatch' | 'changed-after-preflight';

export class RuntimePromotionPreflightError extends Error {
  constructor(readonly reason: RuntimePromotionPreflightFailureReason) {
    super(`Runtime promotion preflight failed (${reason}).`);
    this.name = 'RuntimePromotionPreflightError';
  }
}
