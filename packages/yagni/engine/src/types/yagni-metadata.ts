/**
 * Canonical `metadata.yagni` shape stamped on every YAGNI finding signal.
 */

export interface YagniFindingMetadata {
  readonly detector: string;
  readonly confidence: number;
  readonly category: string;
  readonly evidenceKind: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly recommendation?: string;
}