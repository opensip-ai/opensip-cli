import { isAbsolute, relative } from 'node:path';

export const DEFAULT_SUITE = 'audit';
export const DEFAULT_VERSION = 'latest';
export const DEFAULT_WORKING_DIRECTORY = '.';
export const DEFAULT_BRIEF_PATH = 'opensip-review-brief.json';
export const DEFAULT_SARIF_PATH = 'opensip-review.sarif';
export const STICKY_COMMENT_MARKER = '<!-- opensip-cli-review-brief -->';

const FAIL_ON_VALUES = new Set(['all-errors', 'new-errors', 'new-warnings', 'never']);
const ERROR_SEVERITIES = new Set(['critical', 'high']);
const WARNING_OR_ERROR_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const INPUT_PREFIX = 'INPUT_';
const COMMAND_INPUT_LIMIT = 4096;

function ok(value) {
  return { ok: true, value };
}

function err(message) {
  return { ok: false, error: message };
}

function inputName(name) {
  return `${INPUT_PREFIX}${name.toUpperCase().replaceAll('-', '_')}`;
}

function readInput(env, name, fallback = '') {
  const value = env[inputName(name)];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

export function parseBoolean(value, name) {
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return ok(true);
  if (['false', '0', 'no', 'off'].includes(normalized)) return ok(false);
  return err(`Invalid boolean for ${name}: '${value}'. Use true or false.`);
}

export function normalizeInputs(env = process.env) {
  const booleanInputs = [
    ['changed', 'true'],
    ['annotations', 'true'],
    ['sarif', 'false'],
    ['comment', 'false'],
  ];
  const booleans = {};
  for (const [name, fallback] of booleanInputs) {
    const parsed = parseBoolean(readInput(env, name, fallback), name);
    if (!parsed.ok) return parsed;
    booleans[name] = parsed.value;
  }

  const failOn = readInput(env, 'fail-on', 'new-errors');
  if (!FAIL_ON_VALUES.has(failOn)) {
    return err(
      `Invalid fail-on value '${failOn}'. Use all-errors, new-errors, new-warnings, or never.`,
    );
  }

  return ok({
    suite: readInput(env, 'suite', DEFAULT_SUITE),
    command: readInput(env, 'command'),
    changed: booleans.changed,
    annotations: booleans.annotations,
    sarif: booleans.sarif,
    comment: booleans.comment,
    failOn,
    config: readInput(env, 'config'),
    version: readInput(env, 'version', DEFAULT_VERSION),
    workingDirectory: readInput(env, 'working-directory', DEFAULT_WORKING_DIRECTORY),
    briefPath: readInput(env, 'brief-path', DEFAULT_BRIEF_PATH),
    sarifPath: readInput(env, 'sarif-path', DEFAULT_SARIF_PATH),
    cliBin: env.OPENSIP_ACTION_CLI_BIN?.trim() ?? '',
  });
}

export function tokenizeCommand(command) {
  if (command.length > COMMAND_INPUT_LIMIT) {
    return err(`Command input is too long; limit is ${COMMAND_INPUT_LIMIT} characters.`);
  }

  const tokens = [];
  let current = '';
  let quote = '';
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (quote !== '') {
      if (char === quote) {
        quote = '';
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += '\\';
  if (quote !== '') return err(`Unterminated ${quote} quote in command input.`);
  if (current !== '') tokens.push(current);
  return ok(tokens);
}

function includesJsonFlag(args) {
  return args.some((arg) => arg === '--json' || arg.startsWith('--json='));
}

function cliArgsFromInputs(inputs) {
  if (inputs.command !== '') {
    const tokenized = tokenizeCommand(inputs.command);
    if (!tokenized.ok) return tokenized;
    const commandTokens =
      tokenized.value[0] === 'opensip' ? tokenized.value.slice(1) : tokenized.value;
    if (commandTokens.length === 0) return err('command input did not include a CLI command.');
    const args = includesJsonFlag(commandTokens)
      ? [...commandTokens]
      : [...commandTokens, '--json'];
    if (inputs.config !== '' && !args.includes('--config')) args.push('--config', inputs.config);
    return ok(args);
  }

  const args = ['suite', 'run', inputs.suite, '--json'];
  if (inputs.changed) args.push('--changed');
  if (inputs.config !== '') args.push('--config', inputs.config);
  return ok(args);
}

export function buildCliInvocation(inputs) {
  const args = cliArgsFromInputs(inputs);
  if (!args.ok) return args;
  if (inputs.cliBin !== '') {
    return ok({ command: process.execPath, args: [inputs.cliBin, ...args.value] });
  }
  return ok({ command: 'npx', args: ['--yes', `opensip-cli@${inputs.version}`, ...args.value] });
}

function findJsonObjects(stdout) {
  const trimmed = stdout.trim();
  if (trimmed === '') return err('OpenSIP CLI produced no stdout JSON.');

  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;
  let sawCandidate = false;

  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (depth > 0 && inString) {
      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (depth > 0 && char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) {
        start = index;
        sawCandidate = true;
      }
      depth += 1;
      continue;
    }

    if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        try {
          objects.push(JSON.parse(trimmed.slice(start, index + 1)));
        } catch {
          // Keep scanning: child processes can write non-JSON text that happens
          // to contain balanced braces.
        }
        start = -1;
      }
    }
  }

  if (!sawCandidate) {
    return err('OpenSIP CLI stdout did not contain a JSON object.');
  }
  if (objects.length === 0) {
    return err('OpenSIP CLI stdout did not contain a parseable JSON object.');
  }
  return ok(objects);
}

export function parseCommandOutcome(stdout) {
  const parsed = findJsonObjects(stdout);
  if (!parsed.ok) return parsed;
  let lastShapeError = 'OpenSIP CLI JSON did not include a suite result or signal envelope.';
  for (const outcome of parsed.value.toReversed()) {
    if (isRecord(outcome) && outcome.status === 'error') {
      return coerceCommandOutcome(outcome);
    }
    const coerce = coerceCommandOutcome(outcome);
    if (coerce.ok) return coerce;
    lastShapeError = coerce.error;
  }
  return err(lastShapeError);
}

function coerceCommandOutcome(outcome) {
  if (!isRecord(outcome)) return err('OpenSIP CLI JSON outcome is not an object.');
  if (outcome.status === 'error') {
    const first = Array.isArray(outcome.errors) ? outcome.errors[0] : undefined;
    const message =
      isRecord(first) && typeof first.message === 'string'
        ? first.message
        : 'OpenSIP CLI returned a structured error outcome.';
    return err(message);
  }
  if (isRecord(outcome.data) && outcome.data.type === 'suite-run') {
    if (!isRecord(outcome.data.reviewBrief)) {
      return err('Suite output did not include data.reviewBrief.');
    }
    return ok({ kind: 'suite', outcome, result: outcome.data, brief: outcome.data.reviewBrief });
  }
  if (isRecord(outcome.envelope)) {
    return ok({ kind: 'envelope', outcome, envelope: outcome.envelope });
  }
  return err('OpenSIP CLI JSON did not include a suite result or signal envelope.');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function risksFromBrief(brief) {
  const byRef = new Map();
  for (const risk of [...array(brief.topRisks), ...array(brief.newFindings)]) {
    if (!isRecord(risk)) continue;
    const key = JSON.stringify(risk.signalRef ?? risk);
    byRef.set(key, risk);
  }
  return [...byRef.values()];
}

function riskIsError(risk) {
  return isRecord(risk) && typeof risk.severity === 'string' && ERROR_SEVERITIES.has(risk.severity);
}

function riskIsWarningOrError(risk) {
  return (
    isRecord(risk) &&
    typeof risk.severity === 'string' &&
    WARNING_OR_ERROR_SEVERITIES.has(risk.severity)
  );
}

function baselineAvailable(brief) {
  return isRecord(brief.baselineDelta) && brief.baselineDelta.available === true;
}

export function deriveActionSummary(parsed) {
  if (parsed.kind === 'suite') {
    const { result, brief } = parsed;
    const aggregate = isRecord(result.aggregate) ? result.aggregate : {};
    const errors = integer(aggregate.errors);
    const warnings = integer(aggregate.warnings);
    const baselineDelta = isRecord(brief.baselineDelta) ? brief.baselineDelta : {};
    const verdict =
      typeof brief.verdict === 'string' ? brief.verdict : verdictFromExitCode(result.exitCode);
    const newIssues =
      baselineDelta.available === true
        ? integer(baselineDelta.added)
        : array(brief.newFindings).length;
    return {
      kind: 'suite',
      verdict,
      issues: errors + warnings,
      newIssues,
      degraded: array(brief.degraded)
        .map((item) => (isRecord(item) ? String(item.code ?? item.reason ?? '') : ''))
        .filter(Boolean),
      errors,
      warnings,
      risks: risksFromBrief(brief),
      newRisks: array(brief.newFindings).filter((item) => isRecord(item)),
      baselineAvailable: baselineAvailable(brief),
      brief,
    };
  }

  const envelope = parsed.envelope;
  const summary =
    isRecord(envelope.verdict) && isRecord(envelope.verdict.summary)
      ? envelope.verdict.summary
      : {};
  const errors = integer(summary.errors);
  const warnings = integer(summary.warnings);
  return {
    kind: 'envelope',
    verdict: isRecord(envelope.verdict) && envelope.verdict.passed === true ? 'pass' : 'fail',
    issues: integer(summary.total, errors + warnings),
    newIssues: 0,
    degraded: [],
    errors,
    warnings,
    risks: array(envelope.signals)
      .filter((signal) => isRecord(signal))
      .map((signal, index) => signalToRisk(signal, index)),
    newRisks: [],
    baselineAvailable: false,
    brief: undefined,
  };
}

function signalToRisk(signal, index) {
  return {
    source: typeof signal.tool === 'string' ? signal.tool : 'opensip',
    ruleId: String(signal.ruleId ?? 'opensip.signal'),
    message: String(signal.message ?? 'OpenSIP finding'),
    severity: String(signal.severity ?? 'low'),
    file: String(signal.filePath ?? signal.file ?? ''),
    line: optionalInteger(signal.line),
    column: optionalInteger(signal.column),
    isNew: signal.metadata?.baselineState === 'added' || signal.metadata?.baselineState === 'new',
    signalRef: { tool: 'opensip', suiteRunId: '', stepIndex: 0, signalIndex: index },
  };
}

function verdictFromExitCode(exitCode) {
  return exitCode === 0 ? 'pass' : 'fail';
}

function integer(value, fallback = 0) {
  return Number.isInteger(value) ? value : fallback;
}

function optionalInteger(value) {
  return Number.isInteger(value) ? value : undefined;
}

export function evaluateFailure(summary, failOn) {
  if (failOn === 'never') return { failed: false, reason: 'report-only' };
  if (failOn === 'all-errors') {
    return {
      failed: summary.errors > 0 || summary.risks.some((risk) => riskIsError(risk)),
      reason: 'all-errors',
    };
  }
  if (failOn === 'new-errors') {
    const source = summary.baselineAvailable ? summary.newRisks : summary.risks;
    return { failed: source.some((risk) => riskIsError(risk)), reason: 'new-errors' };
  }
  const source = summary.baselineAvailable ? summary.newRisks : summary.risks;
  return {
    failed: source.some((risk) => riskIsWarningOrError(risk)),
    reason: 'new-warnings',
  };
}

export function risksForAnnotations(summary, failOn) {
  if (failOn === 'all-errors') return summary.risks.filter((risk) => riskIsWarningOrError(risk));
  if (failOn === 'never') return summary.baselineAvailable ? summary.newRisks : summary.risks;
  return summary.baselineAvailable ? summary.newRisks : summary.risks;
}

export function renderAnnotations(summary, failOn, root = '') {
  return risksForAnnotations(summary, failOn).map((risk) => {
    const level = riskIsError(risk) ? 'error' : 'warning';
    const fields = [
      ['file', formatRiskFile(risk.file, root)],
      ['line', risk.line],
      ['col', risk.column === undefined ? undefined : Number(risk.column) + 1],
      ['title', `${risk.source}: ${risk.ruleId}`],
    ]
      .filter(([, value]) => value !== undefined && String(value) !== '')
      .map(([key, value]) => `${key}=${escapeAnnotationProperty(String(value))}`)
      .join(',');
    return `::${level} ${fields}::${escapeAnnotationMessage(risk.message)}`;
  });
}

export function renderComment(summary, root = '') {
  const brief = summary.brief;
  const risks = summary.risks.slice(0, 10);
  const degraded = summary.degraded;
  const lines = [
    STICKY_COMMENT_MARKER,
    `## OpenSIP review: ${summary.verdict.toUpperCase()}`,
    '',
    `Issues: ${summary.issues} total, ${summary.newIssues} new`,
  ];
  if (isRecord(brief?.baselineDelta)) {
    lines.push(
      `Baseline: ${brief.baselineDelta.available ? 'available' : 'unavailable'} (${integer(
        brief.baselineDelta.added,
      )} new, ${integer(brief.baselineDelta.removed)} resolved)`,
    );
  }
  if (risks.length > 0) {
    lines.push('', '### Top risks');
    for (const risk of risks) {
      const file = formatRiskFile(risk.file, root);
      const location = risk.line === undefined ? file : `${file}:${String(risk.line)}`;
      lines.push(`- **${risk.severity}** \`${risk.ruleId}\` ${location} - ${risk.message}`);
    }
  }
  if (degraded.length > 0) {
    lines.push('', '### Degraded evidence');
    for (const item of degraded) lines.push(`- ${item}`);
  }
  if (risks.length > 0) {
    lines.push(
      '',
      '<details><summary>Raw top-risk details</summary>',
      '',
      '```json',
      JSON.stringify(risks, null, 2),
      '```',
      '',
      '</details>',
    );
  }
  return `${lines.join('\n')}\n`;
}

export function renderStepSummary(summary, root = '') {
  const lines = [
    `# OpenSIP review: ${summary.verdict.toUpperCase()}`,
    '',
    `- Issues: ${summary.issues}`,
    `- New issues: ${summary.newIssues}`,
    `- Degraded: ${summary.degraded.length === 0 ? 'none' : summary.degraded.join(', ')}`,
  ];
  const risks = summary.risks.slice(0, 10);
  if (risks.length > 0) {
    lines.push('', '## Top risks');
    for (const risk of risks) {
      const file = formatRiskFile(risk.file, root);
      const location = risk.line === undefined ? file : `${file}:${String(risk.line)}`;
      lines.push(`- ${risk.severity} ${risk.ruleId} ${location} - ${risk.message}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderSarif(summary, root = '') {
  const rules = new Map();
  const results = [];
  for (const risk of summary.risks) {
    if (!rules.has(risk.ruleId)) {
      rules.set(risk.ruleId, {
        id: risk.ruleId,
        shortDescription: { text: risk.ruleId },
        fullDescription: { text: `${risk.source} finding` },
      });
    }
    results.push({
      ruleId: risk.ruleId,
      level: riskIsError(risk) ? 'error' : 'warning',
      message: { text: risk.message },
      locations:
        risk.file === ''
          ? []
          : [
              {
                physicalLocation: {
                  artifactLocation: { uri: formatRiskFile(risk.file, root) },
                  region: {
                    ...(risk.line === undefined ? {} : { startLine: risk.line }),
                    ...(risk.column === undefined ? {} : { startColumn: Number(risk.column) + 1 }),
                  },
                },
              },
            ],
      properties: {
        source: risk.source,
        severity: risk.severity,
        isNew: risk.isNew === true,
      },
    });
  }
  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'opensip-cli github action',
              informationUri: 'https://github.com/opensip-ai/opensip-cli',
              rules: [...rules.values()],
            },
          },
          results,
        },
      ],
    },
    null,
    2,
  );
}

function formatRiskFile(file, root) {
  if (typeof file !== 'string' || file === '') return '';
  if (root === '' || !isAbsolute(file)) return file;
  return displayPath(root, file);
}

export function outputsForSummary(summary, paths) {
  return {
    verdict: summary.verdict,
    issues: String(summary.issues),
    'new-issues': String(summary.newIssues),
    sarif: paths.sarifPath ?? '',
    brief: paths.briefPath,
    degraded: summary.degraded.join(','),
  };
}

export function escapeAnnotationProperty(value) {
  return value
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A')
    .replaceAll(':', '%3A')
    .replaceAll(',', '%2C');
}

export function escapeAnnotationMessage(value) {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

export function displayPath(from, to) {
  const rel = relative(from, to);
  return rel === '' ? '.' : rel;
}
