import type { ProgressEvent } from '@opensip-cli/cli-ui';

/**
 * Friendly checklist row label from a detector slug: drops the `yagni:`
 * namespace and title-cases the kebab tail.
 */
export function detectorLabel(slug: string): string {
  const name = slug.slice(slug.indexOf(':') + 1);
  return name
    .split('-')
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

export function detectorStartEvent(slug: string): ProgressEvent {
  return { type: 'stage-start', stage: slug, label: detectorLabel(slug) };
}

export function detectorDoneEvent(
  slug: string,
  durationMs: number,
  detail?: string,
): ProgressEvent {
  return {
    type: 'stage-done',
    stage: slug,
    durationMs,
    ...(detail === undefined ? {} : { detail }),
  };
}
