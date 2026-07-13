import { editorLinkUrl } from './editor-link.js';
import { el } from './el.js';

const RISK_GUARD = 100;
const CORRELATION_GUARD = 50;
const CORRELATION_MEMBER_GUARD = 50;
const CORRELATION_REASON_GUARD = 20;
const DEGRADATION_GUARD = 50;
const ACTION_GUARD = 50;
const MUTED_CLASS = 'text-muted';

function locationText(file: string, line?: number): string {
  return file + (line === undefined ? '' : `:${String(line)}`);
}

function riskRow(risk: ChangeImpactRisk): HTMLElement {
  const row = el('li', { class: 'change-impact-risk' });
  row.append(
    el('span', {
      class: `badge severity-${risk.severity}`,
      text: risk.severity.toUpperCase(),
    }),
    el('strong', {
      text: `${risk.source} · ${risk.ruleId}${risk.isNew ? ' · NEW' : ''}`,
    }),
    el('div', { text: risk.message }),
  );
  const location = locationText(risk.file, risk.line);
  const href = editorLinkUrl(risk.file, risk.line ?? 1);
  row.append(
    href ? el('a', { href, text: location }) : el('span', { class: MUTED_CLASS, text: location }),
  );
  if (risk.blastRadius) {
    row.append(
      el('div', {
        class: MUTED_CLASS,
        text: `Blast radius: ${String(risk.blastRadius.dependents)} dependents (${risk.blastRadius.confidence})`,
      }),
    );
  }
  return row;
}

function appendRisks(
  section: HTMLElement,
  brief: ChangeImpactReviewBrief,
  omittedByReport: number,
): void {
  const risks = brief.topRisks.slice(0, RISK_GUARD);
  if (risks.length === 0)
    section.append(el('div', { class: 'empty', text: 'No stored review risks.' }));
  else {
    const list = el('ul', { class: 'change-impact-list' });
    risks.forEach((risk) => list.append(riskRow(risk)));
    section.append(list);
  }
  const omittedRisks = brief.topRisks.length - risks.length + omittedByReport;
  if (omittedRisks > 0) {
    section.append(
      el('p', {
        class: MUTED_CLASS,
        text: `${String(omittedRisks)} additional risk entry/entries omitted.`,
      }),
    );
  }
}

function appendCorrelations(
  section: HTMLElement,
  brief: ChangeImpactReviewBrief,
  omittedByReport: number,
): void {
  const correlations = (brief.correlatedRisks ?? []).slice(0, CORRELATION_GUARD);
  for (const group of correlations) {
    const details = el('details', { class: 'change-impact-correlation' }, [
      el('summary', {
        text: `${group.title} · ${group.severity}${group.isNew ? ' · NEW' : ''}`,
      }),
      el('p', {
        text: `Primary: ${group.primary.source} ${group.primary.ruleId} at ${locationText(group.primary.file, group.primary.line)}`,
      }),
    ]);
    const members = group.members.slice(0, CORRELATION_MEMBER_GUARD);
    const memberList = el('ul', { class: 'change-impact-list' });
    members.forEach((member) =>
      memberList.append(
        el('li', {
          text: `Member: ${member.source} ${member.ruleId} at ${locationText(member.file, member.line)}`,
        }),
      ),
    );
    details.append(memberList);
    if (group.members.length > members.length) {
      details.append(
        el('p', {
          class: MUTED_CLASS,
          text: `${String(group.members.length - members.length)} correlation member(s) omitted defensively.`,
        }),
      );
    }
    const reasons = group.reasons.slice(0, CORRELATION_REASON_GUARD);
    reasons.forEach((reason) =>
      details.append(
        el('p', {
          class: MUTED_CLASS,
          text: `${reason.confidence}: ${reason.message}`,
        }),
      ),
    );
    if (group.reasons.length > reasons.length) {
      details.append(
        el('p', {
          class: MUTED_CLASS,
          text: `${String(group.reasons.length - reasons.length)} correlation reason(s) omitted defensively.`,
        }),
      );
    }
    if (group.blastRadius)
      details.append(
        el('p', {
          text: `Blast radius: ${String(group.blastRadius.dependents)} dependents.`,
        }),
      );
    section.append(details);
  }
  const omittedCorrelations =
    (brief.correlatedRisks?.length ?? 0) - correlations.length + omittedByReport;
  if (omittedCorrelations > 0) {
    section.append(
      el('p', {
        class: MUTED_CLASS,
        text: `${String(omittedCorrelations)} correlation group(s) omitted.`,
      }),
    );
  }
}

function appendDegradations(
  section: HTMLElement,
  brief: ChangeImpactReviewBrief,
  omittedByReport: number,
): void {
  const degradations = brief.degraded.slice(0, DEGRADATION_GUARD);
  degradations.forEach((degradation) => {
    section.append(
      el('p', {
        class: MUTED_CLASS,
        text: `Degraded (${degradation.source}): ${degradation.reason}`,
      }),
    );
  });
  const omittedDegradations = brief.degraded.length - degradations.length + omittedByReport;
  if (omittedDegradations > 0) {
    section.append(
      el('p', {
        class: MUTED_CLASS,
        text: `${String(omittedDegradations)} degradation detail(s) omitted.`,
      }),
    );
  }
}

function appendActions(
  section: HTMLElement,
  brief: ChangeImpactReviewBrief,
  omittedByReport: number,
): void {
  const retainedActions = brief.recommendedActions.slice(0, ACTION_GUARD);
  if (retainedActions.length > 0) {
    section.append(el('h4', { text: 'Recommended actions' }));
    const actions = el('ol', { class: 'change-impact-list' });
    retainedActions.forEach((action) => {
      const command = action.command ? ` — ${action.command}` : '';
      actions.append(
        el('li', {
          text: `${action.priority}: ${action.message}${command}`,
        }),
      );
    });
    section.append(actions);
  }
  const omittedActions = brief.recommendedActions.length - retainedActions.length + omittedByReport;
  if (omittedActions > 0) {
    section.append(
      el('p', {
        class: MUTED_CLASS,
        text: `${String(omittedActions)} recommended action(s) omitted.`,
      }),
    );
  }
}

function appendVerificationCommands(section: HTMLElement, model: ChangeImpactViewModel): void {
  const commands = model.evidence?.recommendedCommands ?? [];
  if (commands.length > 0) {
    section.append(el('h4', { text: 'Verification commands' }));
    commands.forEach((command) =>
      section.append(el('code', { class: 'change-impact-command', text: command })),
    );
  }
  if (model.reportOmitted.recommendedCommands > 0) {
    section.append(
      el('p', {
        class: MUTED_CLASS,
        text: `${String(model.reportOmitted.recommendedCommands)} verification command(s) omitted by the report budget.`,
      }),
    );
  }
}

export function renderImpactRisks(container: HTMLElement, model: ChangeImpactViewModel): void {
  const brief = model.reviewBrief;
  const section = el('div', { class: 'card change-impact-risks' }, [
    el('h3', { text: 'Review risks and actions' }),
  ]);
  if (!brief) {
    section.append(el('div', { class: 'empty', text: 'Stored review brief unavailable.' }));
    container.append(section);
    return;
  }
  const baseline = brief.baselineDelta;
  section.append(
    el('p', {
      text: baseline.available
        ? `Baseline: ${String(baseline.added)} added, ${String(baseline.removed)} removed, ${String(baseline.unchanged)} unchanged.`
        : 'Baseline delta unavailable.',
    }),
    el('p', {
      text: `${String(brief.newFindings.length)} retained new finding(s).`,
    }),
  );
  appendRisks(section, brief, model.reportOmitted.risks);
  appendCorrelations(section, brief, model.reportOmitted.correlations);
  appendDegradations(section, brief, model.reportOmitted.degradations);
  appendActions(section, brief, model.reportOmitted.actions);
  appendVerificationCommands(section, model);
  container.append(section);
}
