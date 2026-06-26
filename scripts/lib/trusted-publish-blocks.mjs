/**
 * Step-scoped trusted-publish parsing shared by verify-supply-chain.mjs and the
 * reusable package-supply-chain-policy fitness check.
 */

export function splitWorkflowSteps(content) {
  const lines = content.split('\n');
  const steps = [];
  let current = [];
  for (const line of lines) {
    if (/^\s*-\s+name:/.test(line) && current.length > 0) {
      steps.push(current.join('\n'));
      current = [line];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) steps.push(current.join('\n'));
  return steps;
}

export function executableStepText(step) {
  return step
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/** Executable workflow step bodies that invoke `npm publish`. */
export function extractPublishBlocks(workflowContent) {
  const blocks = [];
  for (const step of splitWorkflowSteps(workflowContent)) {
    const executable = executableStepText(step);
    if (/\bnpm\s+publish\b/.test(executable)) {
      blocks.push(executable);
    }
  }
  return blocks;
}

export function publishBlockHasProvenance(block) {
  return /(--provenance|NPM_CONFIG_PROVENANCE\s*[:=]\s*true|provenance:\s*true)/.test(block);
}

export function publishBlockReferencesLongLivedToken(block) {
  return /\bnpm\s+publish\b/.test(block) && /(NPM_TOKEN|NODE_AUTH_TOKEN)/.test(block);
}
