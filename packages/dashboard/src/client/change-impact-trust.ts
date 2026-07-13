import { el } from './el.js';

const availabilityCopy: Readonly<Record<ChangeImpactViewModel['availability'], string>> = {
  available: 'Stored impact evidence is available.',
  'projection-degraded': 'Analysis completed, but its bounded report projection was omitted.',
  'step-faulted': 'The graph impact step faulted. Do not infer a clean result.',
  'missing-session':
    'The authoritative graph session link is unavailable. No latest-session fallback was used.',
  legacy: 'This run predates stored Change Impact evidence.',
  malformed: 'Stored impact evidence failed validation and was not rendered.',
};

export function renderImpactTrust(container: HTMLElement, model: ChangeImpactViewModel): void {
  const card = el('div', { class: 'card change-impact-trust' }, [
    el('h3', { text: 'Evidence quality' }),
    el('div', {
      class: `badge trust-${model.availability}`,
      text: model.availability.replaceAll('-', ' '),
    }),
    el('p', { text: availabilityCopy[model.availability] }),
  ]);
  if (model.availabilityReason !== availabilityCopy[model.availability]) {
    card.append(el('p', { class: 'text-muted', text: model.availabilityReason }));
  }
  const evidence = model.evidence;
  if (evidence) {
    const trust = evidence.trust;
    const verifiedText = trust.fullyVerified
      ? 'Fully verified for the stored scope.'
      : 'Not fully verified; inspect uncertainties before making coverage claims.';
    card.append(
      el('dl', { class: 'change-impact-facts' }, [
        el('dt', { text: 'Coverage' }),
        el('dd', { text: trust.coverage }),
        el('dt', { text: 'Fallback' }),
        el('dd', { text: trust.fallback }),
        el('dt', { text: 'Verification' }),
        el('dd', { text: verifiedText }),
        el('dt', { text: 'Catalog qualification' }),
        el('dd', { text: model.catalogMatch.replaceAll('-', ' ') }),
        el('dt', { text: 'Backend rows omitted' }),
        el('dd', {
          text: String(
            Object.values(evidence.backendOmitted).reduce((total, count) => total + count, 0),
          ),
        }),
        el('dt', { text: 'Report rows omitted' }),
        el('dd', {
          text: String(
            model.reportOmitted.changedFiles +
              model.reportOmitted.changedFunctions +
              model.reportOmitted.impactedFunctions +
              model.reportOmitted.impactedFiles +
              model.reportOmitted.impactedPackages +
              model.reportOmitted.recommendedCommands,
          ),
        }),
        el('dt', { text: 'Uncertainties omitted' }),
        el('dd', { text: String(model.reportOmitted.uncertainties) }),
      ]),
    );
    if (model.zeroImpact) {
      card.append(
        el('p', {
          text:
            trust.coverage === 'full' && trust.fullyVerified
              ? 'Verified zero stored impact for this scope.'
              : 'No stored impact found; coverage is not complete enough to claim zero risk.',
        }),
      );
    }
    if (model.sourceTruncated || evidence.detailTruncated || evidence.metadataOmitted) {
      card.append(
        el('p', {
          class: 'text-muted',
          text: 'Some source or display evidence was truncated or omitted.',
        }),
      );
    }
    if (trust.uncertainties.length > 0) {
      const list = el('ul', { class: 'change-impact-list' });
      [...trust.uncertainties]
        .sort((left, right) => {
          const leftKey = `${left.code}\0${left.source}\0${left.message}`;
          const rightKey = `${right.code}\0${right.source}\0${right.message}`;
          if (leftKey < rightKey) return -1;
          if (leftKey > rightKey) return 1;
          return 0;
        })
        .forEach((uncertainty) => {
          const location = uncertainty.filePath ? ` — ${uncertainty.filePath}` : '';
          list.append(
            el('li', {
              text: `${uncertainty.code} (${uncertainty.source}): ${uncertainty.message}${location}`,
            }),
          );
        });
      card.append(list);
    }
  }
  container.append(card);
}
