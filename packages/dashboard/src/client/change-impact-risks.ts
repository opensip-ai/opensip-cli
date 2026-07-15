import { CHANGE_IMPACT_CLIENT_CAPS, boundClientRows } from './change-impact-bounds.js';
import { editorLinkUrl } from './editor-link.js';
import { el } from './el.js';

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

interface AppendRiskListInput {
  readonly section: HTMLElement;
  readonly title: string;
  readonly emptyText: string;
  readonly values: readonly ChangeImpactRisk[];
  readonly clientCap: number;
  readonly omittedByReport: number;
  readonly reportOmissionLabel: string;
  readonly clientOmissionLabel: string;
}

function appendRiskList(input: AppendRiskListInput): void {
  const {
    section,
    title,
    emptyText,
    values,
    clientCap,
    omittedByReport,
    reportOmissionLabel,
    clientOmissionLabel,
  } = input;
  section.append(el('h4', { text: title }));
  const risks = boundClientRows(values, clientCap);
  if (risks.rows.length === 0) section.append(el('div', { class: 'empty', text: emptyText }));
  else {
    const list = el('ul', { class: 'change-impact-list' });
    risks.rows.forEach((risk) => list.append(riskRow(risk)));
    section.append(list);
  }
  if (omittedByReport > 0) {
    section.append(
      el('p', {
        class: MUTED_CLASS,
        text: `${String(omittedByReport)} ${reportOmissionLabel}`,
      }),
    );
  }
  if (risks.omitted > 0) {
    section.append(
      el('p', {
        class: MUTED_CLASS,
        text: `${String(risks.omitted)} ${clientOmissionLabel}`,
      }),
    );
  }
}

function appendRisks(
  section: HTMLElement,
  brief: ChangeImpactReviewBrief,
  omittedByReport: number,
): void {
  appendRiskList({
    section,
    title: 'Top risks',
    emptyText: 'No stored review risks.',
    values: brief.topRisks,
    clientCap: CHANGE_IMPACT_CLIENT_CAPS.risks,
    omittedByReport,
    reportOmissionLabel: 'risk entry/entries omitted by the report budget.',
    clientOmissionLabel: 'risk entry/entries omitted by the defensive client limit.',
  });
}

function appendNewFindings(
  section: HTMLElement,
  brief: ChangeImpactReviewBrief,
  omittedByReport: number,
): void {
  appendRiskList({
    section,
    title: 'New findings',
    emptyText: 'No stored new findings.',
    values: brief.newFindings,
    clientCap: CHANGE_IMPACT_CLIENT_CAPS.newFindings,
    omittedByReport,
    reportOmissionLabel: 'new finding(s) omitted by the report budget.',
    clientOmissionLabel: 'new finding(s) omitted by the defensive client limit.',
  });
}

function appendCorrelations(
  section: HTMLElement,
  brief: ChangeImpactReviewBrief,
  omittedByReport: number,
): void {
  const correlations = boundClientRows(
    brief.correlatedRisks ?? [],
    CHANGE_IMPACT_CLIENT_CAPS.correlations,
  );
  for (const group of correlations.rows) {
    const details = el('details', { class: 'change-impact-correlation' }, [
      el('summary', {
        text: `${group.title} · ${group.severity}${group.isNew ? ' · NEW' : ''}`,
      }),
      el('p', {
        text: `Primary: ${group.primary.source} ${group.primary.ruleId} at ${locationText(group.primary.file, group.primary.line)}`,
      }),
    ]);
    const members = group.members.slice(0, CHANGE_IMPACT_CLIENT_CAPS.correlationMembers);
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
    const reasons = group.reasons.slice(0, CHANGE_IMPACT_CLIENT_CAPS.correlationReasons);
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
  if (omittedByReport > 0) {
    section.append(
      el('p', {
        class: MUTED_CLASS,
        text: `${String(omittedByReport)} correlation group(s) omitted by the report budget.`,
      }),
    );
  }
  if (correlations.omitted > 0) {
    section.append(
      el('p', {
        class: MUTED_CLASS,
        text: `${String(correlations.omitted)} correlation group(s) omitted by the defensive client limit.`,
      }),
    );
  }
}

function appendDegradations(
  section: HTMLElement,
  brief: ChangeImpactReviewBrief,
  omittedByReport: number,
): void {
  const degradations = boundClientRows(brief.degraded, CHANGE_IMPACT_CLIENT_CAPS.degradations);
  degradations.rows.forEach((degradation) => {
    section.append(
      el('p', {
        class: MUTED_CLASS,
        text: `Degraded (${degradation.source}): ${degradation.reason}`,
      }),
    );
  });
  if (omittedByReport > 0) {
    section.append(
      el('p', {
        class: MUTED_CLASS,
        text: `${String(omittedByReport)} degradation detail(s) omitted by the report budget.`,
      }),
    );
  }
  if (degradations.omitted > 0) {
    section.append(
      el('p', {
        class: MUTED_CLASS,
        text: `${String(degradations.omitted)} degradation detail(s) omitted by the defensive client limit.`,
      }),
    );
  }
}

function appendActions(
  section: HTMLElement,
  brief: ChangeImpactReviewBrief,
  omittedByReport: number,
): void {
  const retainedActions = boundClientRows(
    brief.recommendedActions,
    CHANGE_IMPACT_CLIENT_CAPS.actions,
  );
  if (retainedActions.rows.length > 0) {
    section.append(el('h4', { text: 'Recommended actions' }));
    const actions = el('ol', { class: 'change-impact-list' });
    retainedActions.rows.forEach((action) => {
      const command = action.command ? ` — ${action.command}` : '';
      actions.append(
        el('li', {
          text: `${action.priority}: ${action.message}${command}`,
        }),
      );
    });
    section.append(actions);
  }
  if (omittedByReport > 0) {
    section.append(
      el('p', {
        class: MUTED_CLASS,
        text: `${String(omittedByReport)} recommended action(s) omitted by the report budget.`,
      }),
    );
  }
  if (retainedActions.omitted > 0) {
    section.append(
      el('p', {
        class: MUTED_CLASS,
        text: `${String(retainedActions.omitted)} recommended action(s) omitted by the defensive client limit.`,
      }),
    );
  }
}

function appendVerificationCommands(section: HTMLElement, model: ChangeImpactViewModel): void {
  const commands = boundClientRows(
    model.evidence?.recommendedCommands ?? [],
    CHANGE_IMPACT_CLIENT_CAPS.recommendedCommands,
  );
  if (commands.rows.length > 0) {
    section.append(el('h4', { text: 'Verification commands' }));
    commands.rows.forEach((command) =>
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
  if (commands.omitted > 0) {
    section.append(
      el('p', {
        class: MUTED_CLASS,
        text: `${String(commands.omitted)} verification command(s) omitted by the defensive client limit.`,
      }),
    );
  }
}

export function renderImpactRisks(container: HTMLElement, model: ChangeImpactViewModel): void {
  const brief = model.reviewBrief;
  const section = el('section', { class: 'card change-impact-risks' }, [
    el('h3', { text: 'Review risks and actions' }),
  ]);
  if (!brief) {
    section.append(
      el('div', {
        class: 'empty',
        text:
          model.reviewBriefState === 'malformed'
            ? 'Stored review brief is malformed and was not rendered. Treat this review as incomplete.'
            : 'Stored review brief unavailable.',
      }),
    );
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
  );
  // Render both capped lists. topRisks and newFindings can diverge when older
  // high-severity risks fill the top cap and lower-severity net-new findings
  // only appear on the dedicated newFindings list.
  appendRisks(section, brief, model.reportOmitted.risks);
  appendNewFindings(section, brief, model.reportOmitted.newFindings);
  appendCorrelations(section, brief, model.reportOmitted.correlations);
  appendDegradations(section, brief, model.reportOmitted.degradations);
  appendActions(section, brief, model.reportOmitted.actions);
  appendVerificationCommands(section, model);
  container.append(section);
}
