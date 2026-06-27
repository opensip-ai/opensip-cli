/**
 * Dockerfile analysis logic for docker-best-practices.
 */

import {
  APT_UPGRADE_PATTERN,
  COPY_PATTERN,
  FROM_IMAGE_PATTERN,
  FROM_STAGE_PATTERN,
  NODE_ENV_PROD_PATTERN,
  NODE_MODULES_FROM_STAGE_PATTERN,
  PACKAGE_FILE_COPY_PATTERN,
  PACKAGE_MANAGER_PATTERNS,
  PKG_INSTALL_PATTERN,
  PROD_DEPS_FLAG_PATTERN,
  isRunnerStageName,
  SECRET_PATTERNS,
  USER_PATTERN,
  safeDockerLine,
  type AnalysisState,
  type DockerfileViolation,
} from './docker-best-practices-patterns.js';

function checkForSecrets(
  line: string,
  lineNum: number,
  file: string,
  filePath: string,
): DockerfileViolation | null {
  const safeLine = safeDockerLine(line);
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(safeLine)) {
      return {
        file,
        filePath,
        line: lineNum,
        rule: 'no-hardcoded-secrets',
        message: 'Hardcoded secret detected in Dockerfile',
        severity: 'error',
        suggestion:
          'Use build arguments, runtime environment variables, or a secrets manager instead',
      };
    }
  }
  return null;
}

function checkRunCommand(
  line: string,
  lineNum: number,
  file: string,
  filePath: string,
): { violations: DockerfileViolation[]; hasFrozenLockfileViolation: boolean } {
  const violations: DockerfileViolation[] = [];
  let hasFrozenLockfileViolation = false;
  const safeLine = safeDockerLine(line);

  for (const { pattern, manager, fix } of PACKAGE_MANAGER_PATTERNS) {
    if (pattern.test(safeLine)) {
      hasFrozenLockfileViolation = true;
      violations.push({
        file,
        filePath,
        line: lineNum,
        rule: 'frozen-lockfile',
        message: `${manager} install without frozen lockfile flag`,
        severity: 'error',
        suggestion: `Add ${fix} to ensure reproducible builds`,
      });
    }
  }

  if (APT_UPGRADE_PATTERN.test(safeLine)) {
    violations.push({
      file,
      filePath,
      line: lineNum,
      rule: 'no-apt-upgrade',
      message: 'apt-get upgrade makes builds non-reproducible',
      severity: 'warning',
      suggestion: 'Pin specific package versions instead of upgrading all packages',
    });
  }

  return { violations, hasFrozenLockfileViolation };
}

interface CheckCopyOrderOptions {
  line: string;
  lineNum: number;
  file: string;
  filePath: string;
  lines: string[];
  lastFromLine: number;
  lineIndex: number;
}

function checkCopyOrder(options: CheckCopyOrderOptions): DockerfileViolation | null {
  const { line, lineNum, file, filePath, lines, lastFromLine, lineIndex } = options;

  /* v8 ignore next 4 */
  if (!Array.isArray(lines)) {
    return null;
  }

  const safeLine = safeDockerLine(line);
  const copyMatch = COPY_PATTERN.exec(safeLine);
  if (copyMatch?.[1] !== '.' && copyMatch?.[1] !== './') return null;
  if (safeLine.includes('--from=')) return null;

  const stageLines = lines.slice(lastFromLine, lineIndex);

  const hasPackageFileCopy = stageLines.some((l) =>
    PACKAGE_FILE_COPY_PATTERN.test(safeDockerLine(l)),
  );

  const hasNodeModulesFromStage = stageLines.some((l) =>
    NODE_MODULES_FROM_STAGE_PATTERN.test(safeDockerLine(l)),
  );

  if (!hasPackageFileCopy && !hasNodeModulesFromStage) {
    return {
      file,
      filePath,
      line: lineNum,
      rule: 'copy-order',
      message: 'COPY . before copying dependency files',
      severity: 'warning',
      suggestion:
        'Copy package.json and lockfile first, run install, then copy source for better layer caching',
    };
  }
  return null;
}

function checkCacheMount(
  line: string,
  lineNum: number,
  file: string,
  filePath: string,
): DockerfileViolation | null {
  const safeLine = safeDockerLine(line);
  if (PKG_INSTALL_PATTERN.test(safeLine) && !safeLine.includes('--mount=type=cache')) {
    return {
      file,
      filePath,
      line: lineNum,
      rule: 'cache-mount',
      message: 'Package install without BuildKit cache mount',
      severity: 'warning',
      suggestion:
        'Add --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store to cache the package store across builds',
    };
  }
  return null;
}

/* v8 ignore start */
function processFromLine(line: string, lineNum: number, state: AnalysisState): void {
  state.fromCount++;
  state.lastFromLine = lineNum;
  const safeLine = safeDockerLine(line);
  const match = FROM_IMAGE_PATTERN.exec(safeLine);
  const baseImage = match?.[1] ?? null;
  if (baseImage) state.baseImages.push(baseImage);

  const stageMatch = FROM_STAGE_PATTERN.exec(safeLine);
  const stageName = stageMatch?.[1]?.toLowerCase() ?? null;

  if (stageName) {
    state.isInRunnerStage = isRunnerStageName(stageName);
  } else if (state.fromCount > 1) {
    state.isInRunnerStage = true;
  }

  if (state.isInRunnerStage) {
    state.runnerStageBaseImage = baseImage;
    state.runnerFromLine = lineNum;

    if (baseImage) {
      const baseImageLower = baseImage.toLowerCase();
      state.runnerInheritsBuildStage = state.stageNames.includes(baseImageLower);
    }
  }

  if (stageName) {
    state.stageNames.push(stageName);
  }
}

function addMissingBestPracticeViolations(
  file: string,
  filePath: string,
  lineCount: number,
  state: AnalysisState,
): DockerfileViolation[] {
  const violations: DockerfileViolation[] = [];
  const hasMultiStage = state.fromCount >= 2;

  if (!hasMultiStage && state.fromCount > 0) {
    violations.push({
      file,
      filePath,
      line: 1,
      rule: 'multi-stage-build',
      message: 'Dockerfile does not use multi-stage build',
      severity: 'error',
      suggestion:
        'Use separate stages for building and running to reduce image size and attack surface',
    });
  }

  if (!state.hasNonRootUser && state.fromCount > 0) {
    violations.push({
      file,
      filePath,
      line: lineCount,
      rule: 'non-root-user',
      message: 'Dockerfile does not specify a non-root user',
      severity: 'error',
      suggestion: String.raw`Add USER directive with a non-root user: RUN addgroup --system app && adduser --system --ingroup app app\nUSER app`,
    });
  }

  if (!state.hasHealthcheck && state.fromCount > 0) {
    violations.push({
      file,
      filePath,
      line: lineCount,
      rule: 'healthcheck',
      message: 'Dockerfile does not include a HEALTHCHECK instruction',
      severity: 'warning',
      suggestion: 'Add HEALTHCHECK to help orchestrators verify container health',
    });
  }

  const runnerUsesNode = state.runnerStageBaseImage?.includes('node') ?? false;
  if (runnerUsesNode && !state.hasNodeEnvProduction) {
    violations.push({
      file,
      filePath,
      line: lineCount,
      rule: 'node-env-production',
      message: 'NODE_ENV=production not set in runtime stage',
      severity: 'warning',
      suggestion: 'Add ENV NODE_ENV=production in the runner stage for Node.js optimizations',
    });
  }

  if (state.runnerCopiesNodeModules && !state.hasProductionDepsFlag) {
    violations.push({
      file,
      filePath,
      line: state.runnerNodeModulesLine,
      rule: 'production-dependencies',
      message: 'Runtime image copies node_modules without production-only dependency resolution',
      severity: 'error',
      suggestion:
        'Use "pnpm deploy --prod" to create a production bundle, or add --prod to install command to exclude devDependencies from the runtime image',
    });
  }

  if (state.runnerInheritsBuildStage) {
    violations.push({
      file,
      filePath,
      line: state.runnerFromLine,
      rule: 'no-build-tools-in-runner',
      message:
        'Runtime stage inherits from a build stage that may include build tools (pnpm, corepack, etc.)',
      severity: 'warning',
      suggestion:
        'Use a clean base image (e.g., node:20-alpine) for the runtime stage instead of inheriting from a build stage',
    });
  }

  return violations;
}
/* v8 ignore stop */

function processUserLine(trimmedLine: string, state: AnalysisState): void {
  const safeLine = safeDockerLine(trimmedLine);
  const userMatch = USER_PATTERN.exec(safeLine);
  if (userMatch?.[1] && userMatch[1] !== 'root') {
    state.hasNonRootUser = true;
  }
}

interface ProcessRunLineOptions {
  trimmedLine: string;
  lineNum: number;
  file: string;
  filePath: string;
  state: AnalysisState;
  violations: DockerfileViolation[];
}

function processRunLine(options: ProcessRunLineOptions): void {
  const { trimmedLine, lineNum, file, filePath, state, violations } = options;
  const runResult = checkRunCommand(trimmedLine, lineNum, file, filePath);
  violations.push(...runResult.violations);
  if (runResult.hasFrozenLockfileViolation) state.hasFrozenLockfile = false;

  const cacheMountViolation = checkCacheMount(trimmedLine, lineNum, file, filePath);
  if (cacheMountViolation) violations.push(cacheMountViolation);

  if (PROD_DEPS_FLAG_PATTERN.test(safeDockerLine(trimmedLine))) {
    state.hasProductionDepsFlag = true;
  }
}

interface ProcessCopyLineOptions {
  trimmedLine: string;
  lineNum: number;
  index: number;
  lines: string[];
  file: string;
  filePath: string;
  state: AnalysisState;
  violations: DockerfileViolation[];
}

function processCopyLine(options: ProcessCopyLineOptions): void {
  const { trimmedLine, lineNum, index, lines, file, filePath, state, violations } = options;
  const copyViolation = checkCopyOrder({
    line: trimmedLine,
    lineNum,
    file,
    filePath,
    lines,
    lastFromLine: state.lastFromLine,
    lineIndex: index,
  });
  if (copyViolation) violations.push(copyViolation);

  if (state.isInRunnerStage && NODE_MODULES_FROM_STAGE_PATTERN.test(safeDockerLine(trimmedLine))) {
    state.runnerCopiesNodeModules = true;
    state.runnerNodeModulesLine = lineNum;
  }
}

interface ProcessDockerfileLineOptions {
  line: string | undefined;
  index: number;
  lines: string[];
  state: AnalysisState;
  violations: DockerfileViolation[];
  file: string;
  filePath: string;
}

function processDockerfileLine(options: ProcessDockerfileLineOptions): void {
  const { line, index, lines, state, violations, file, filePath } = options;
  /* v8 ignore next */
  const trimmedLine = line?.trim() ?? '';
  if (!trimmedLine || trimmedLine.startsWith('#')) return;

  const upperLine = trimmedLine.toUpperCase();
  const lineNum = index + 1;

  if (upperLine.startsWith('FROM ')) {
    processFromLine(trimmedLine, lineNum, state);
  }

  if (upperLine.startsWith('USER ')) {
    processUserLine(trimmedLine, state);
  }

  if (upperLine.startsWith('HEALTHCHECK ')) {
    state.hasHealthcheck = true;
  }

  if (NODE_ENV_PROD_PATTERN.test(safeDockerLine(trimmedLine))) {
    state.hasNodeEnvProduction = true;
  }

  const secretViolation = checkForSecrets(trimmedLine, lineNum, file, filePath);
  if (secretViolation) violations.push(secretViolation);

  if (upperLine.startsWith('RUN ')) {
    processRunLine({ trimmedLine, lineNum, file, filePath, state, violations });
  }

  if (upperLine.startsWith('COPY ')) {
    processCopyLine({
      trimmedLine,
      lineNum,
      index,
      lines,
      file,
      filePath,
      state,
      violations,
    });
  }
}

/** Analyze a Dockerfile for best-practice violations. */
export function analyzeDockerfile(
  content: string,
  filePath: string,
  file: string,
): DockerfileViolation[] {
  const lines = content.split('\n');
  const violations: DockerfileViolation[] = [];

  const state: AnalysisState = {
    hasNonRootUser: false,
    hasHealthcheck: false,
    hasFrozenLockfile: true,
    hasNodeEnvProduction: false,
    hasProductionDepsFlag: false,
    baseImages: [],
    fromCount: 0,
    isInRunnerStage: false,
    runnerStageBaseImage: null,
    lastFromLine: 0,
    stageNames: [],
    runnerCopiesNodeModules: false,
    runnerNodeModulesLine: 0,
    runnerInheritsBuildStage: false,
    runnerFromLine: 0,
  };

  for (let i = 0; i < lines.length; i++) {
    processDockerfileLine({
      line: lines[i],
      index: i,
      lines,
      state,
      violations,
      file,
      filePath,
    });
  }

  violations.push(...addMissingBestPracticeViolations(file, filePath, lines.length, state));

  return violations;
}
