/** Coarse classes of host resources a tool or capability pack may declare it needs. */
export type ToolResourceClass = 'filesystem' | 'network' | 'env' | 'subprocess';

/**
 * Declaration of a needed host resource. The policy plane interprets this shape
 * for admission and capability worker isolation.
 */
export interface ToolResourceRequirement {
  readonly resource: ToolResourceClass;
  readonly scope?: string;
  readonly reason?: string;
}
