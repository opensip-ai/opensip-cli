/**
 * VIOLATION fixture — variant 2 (narrowed then dropped), severity `warning`.
 *
 * Reduced from the real confirmed site
 * `packages/graph/engine/src/read/impact-view.ts` (the catch at line 137 in the
 * tree this fixture was cut from). The catch body is the shape that ships; only
 * the projection above it is elided.
 *
 * Why it is a defect: the author had a live, inspectable failure and narrowed it
 * twice — so the value was demonstrably in hand — then let every branch return a
 * value assembled entirely from literals. The two classified branches are fine.
 * The fall-through `GRAPH.READ.IMPACT_FAILED` is the loss: a corrupt catalog, an
 * EACCES on the index file and an out-of-memory all collapse into the same
 * sentence, with no `cause` to reopen. This is a boundary an MCP client reads,
 * so nothing downstream can recover what was thrown away here.
 */
export class ComputeImpactCancelledError extends Error {}
export class ComputeImpactIndexGenerationMismatchError extends Error {}

interface ImpactErrorShape {
  readonly code: string;
  readonly message: string;
}

declare function buildProjection(): Promise<{ readonly nodes: number }>;

function impactError(code: string, message: string): ImpactErrorShape {
  return { code, message };
}

function ok<T>(value: T): { status: 'ok'; value: T } {
  return { status: 'ok', value };
}

function err(value: ImpactErrorShape): { status: 'err'; error: ImpactErrorShape } {
  return { status: 'err', error: value };
}

export async function readImpactView(): Promise<
  { status: 'ok'; value: { nodes: number } } | { status: 'err'; error: ImpactErrorShape }
> {
  try {
    return ok(await buildProjection());
  } catch (error) {
    if (error instanceof ComputeImpactCancelledError) {
      return err(impactError('GRAPH.READ.IMPACT_CANCELLED', 'Graph impact read was cancelled'));
    }
    if (error instanceof ComputeImpactIndexGenerationMismatchError) {
      return err(
        impactError(
          'GRAPH.READ.IMPACT_INDEX_GENERATION_MISMATCH',
          'Impact index belongs to a different graph catalog generation',
        ),
      );
    }
    return err(impactError('GRAPH.READ.IMPACT_FAILED', 'Failed to build graph impact projection'));
  }
}
