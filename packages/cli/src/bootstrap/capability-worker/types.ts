import type {
  CapabilityBridgePackage,
  CapabilityBridgeResourceDecision,
  CapabilityDiscoveryDescriptor,
} from '@opensip-cli/core';

export interface CapabilityWorkerSpec {
  readonly ownerToolId: string;
  readonly domainId: string;
  readonly descriptor: CapabilityDiscoveryDescriptor;
  readonly pkg: CapabilityBridgePackage;
  readonly resourceDecision: CapabilityBridgeResourceDecision;
  readonly request: unknown;
}

export interface CapabilityWorkerErrorPayload {
  readonly message: string;
  readonly stack?: string;
  readonly failureClass?: string;
}
