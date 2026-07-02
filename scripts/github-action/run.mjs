#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  STICKY_COMMENT_MARKER,
  buildCliInvocation,
  deriveActionSummary,
  displayPath,
  evaluateFailure,
  normalizeInputs,
  outputsForSummary,
  parseCommandOutcome,
  renderAnnotations,
  renderComment,
  renderSarif,
  renderStepSummary,
} from './action-lib.mjs';

const result = await main();
process.exitCode = result;

async function main() {
  const normalized = normalizeInputs(process.env);
  if (!normalized.ok) {
    workflowError(normalized.error);
    return 1;
  }

  const inputs = normalized.value;
  const invocation = buildCliInvocation(inputs);
  if (!invocation.ok) {
    workflowError(invocation.error);
    return 1;
  }

  const workingDirectoryResult = resolveWorkingDirectory(inputs.workingDirectory);
  if (!workingDirectoryResult.ok) {
    workflowError(workingDirectoryResult.error);
    return 1;
  }
  const workingDirectory = workingDirectoryResult.value;
  const run = await runCommand(invocation.value.command, invocation.value.args, workingDirectory);
  const parsed = parseCommandOutcome(run.stdout);
  if (!parsed.ok) {
    writeDebugFile(workingDirectory, 'opensip-action-stdout.txt', run.stdout);
    writeDebugFile(workingDirectory, 'opensip-action-stderr.txt', run.stderr);
    workflowError(`${parsed.error}. CLI exit code was ${String(run.exitCode)}.`);
    if (run.stderr.trim() !== '') workflowWarning(truncate(run.stderr.trim(), 1000));
    return 1;
  }

  const summary = deriveActionSummary(parsed.value);
  const briefPath = resolve(workingDirectory, inputs.briefPath);
  writeJson(briefPath, summary.brief ?? parsed.value.envelope);

  let sarifPath = '';
  if (inputs.sarif) {
    sarifPath = resolve(workingDirectory, inputs.sarifPath);
    writeText(sarifPath, `${renderSarif(summary, workingDirectory)}\n`);
  }

  if (inputs.annotations) {
    for (const line of renderAnnotations(summary, inputs.failOn, workingDirectory)) {
      process.stdout.write(`${line}\n`);
    }
  }

  writeStepSummary(renderStepSummary(summary, workingDirectory));
  writeOutputs(
    outputsForSummary(summary, {
      briefPath: displayPath(workingDirectory, briefPath),
      sarifPath: sarifPath === '' ? '' : displayPath(workingDirectory, sarifPath),
    }),
  );

  if (inputs.comment) {
    const body = renderComment(summary, workingDirectory);
    await upsertPullRequestComment(body);
  }

  const failure = evaluateFailure(summary, inputs.failOn);
  if (failure.failed) {
    workflowError(`OpenSIP ${failure.reason} policy failed.`);
    return 1;
  }
  return 0;
}

function resolveWorkingDirectory(input) {
  try {
    return { ok: true, value: realpathSync(resolve(input)) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `working-directory '${input}' is not accessible: ${message}`,
    };
  }
}

function runCommand(command, args, cwd) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', (error) => {
      resolveRun({ stdout, stderr: `${stderr}\n${error.message}`, exitCode: 1 });
    });
    child.on('close', (code) => {
      resolveRun({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeDebugFile(directory, name, value) {
  if (value === '') return;
  writeText(resolve(directory, name), value);
}

function writeOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath === undefined || outputPath === '') return;
  const lines = [];
  for (const [key, value] of Object.entries(outputs)) {
    lines.push(`${key}=${value}`);
  }
  appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function writeStepSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath === undefined || summaryPath === '') return;
  appendFileSync(summaryPath, markdown, 'utf8');
}

async function upsertPullRequestComment(body) {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (token === undefined || token === '' || repository === undefined || eventPath === undefined) {
    workflowWarning(
      'Skipping OpenSIP PR comment: pull request token or event metadata is unavailable.',
    );
    return;
  }
  if (!existsSync(eventPath)) {
    workflowWarning('Skipping OpenSIP PR comment: GITHUB_EVENT_PATH does not exist.');
    return;
  }

  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  const issueNumber = event?.pull_request?.number;
  if (!Number.isInteger(issueNumber)) {
    workflowWarning('Skipping OpenSIP PR comment: workflow event is not a pull request.');
    return;
  }

  const [owner, repo] = repository.split('/');
  if (owner === undefined || repo === undefined) {
    workflowWarning('Skipping OpenSIP PR comment: GITHUB_REPOSITORY is malformed.');
    return;
  }

  const base = `https://api.github.com/repos/${owner}/${repo}/issues/${String(issueNumber)}/comments`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'opensip-cli-action',
  };

  try {
    const list = await fetch(base, { headers });
    if (!list.ok) throw new Error(`list comments failed with HTTP ${String(list.status)}`);
    const comments = await list.json();
    const existing = Array.isArray(comments)
      ? comments.find(
          (comment) =>
            typeof comment.body === 'string' && comment.body.includes(STICKY_COMMENT_MARKER),
        )
      : undefined;
    const payload = JSON.stringify({ body });
    const response =
      existing === undefined
        ? await fetch(base, { method: 'POST', headers, body: payload })
        : await fetch(`${base}/${String(existing.id)}`, {
            method: 'PATCH',
            headers,
            body: payload,
          });
    if (!response.ok) throw new Error(`write comment failed with HTTP ${String(response.status)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    workflowWarning(`Skipping OpenSIP PR comment: ${message}`);
  }
}

function workflowError(message) {
  process.stderr.write(`::error::${escapeWorkflowMessage(message)}\n`);
}

function workflowWarning(message) {
  process.stderr.write(`::warning::${escapeWorkflowMessage(message)}\n`);
}

function escapeWorkflowMessage(message) {
  return message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}
