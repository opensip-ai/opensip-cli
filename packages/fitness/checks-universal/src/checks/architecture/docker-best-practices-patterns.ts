/**
 * Pre-compiled regex patterns and state types for docker-best-practices.
 */

export interface DockerfileViolation {
  file: string;
  filePath: string;
  line: number;
  rule: string;
  message: string;
  severity: 'error' | 'warning';
  suggestion?: string;
}

export interface AnalysisState {
  hasNonRootUser: boolean;
  hasHealthcheck: boolean;
  hasFrozenLockfile: boolean;
  hasNodeEnvProduction: boolean;
  hasProductionDepsFlag: boolean;
  baseImages: string[];
  fromCount: number;
  isInRunnerStage: boolean;
  runnerStageBaseImage: string | null;
  lastFromLine: number;
  stageNames: string[];
  runnerCopiesNodeModules: boolean;
  runnerNodeModulesLine: number;
  runnerInheritsBuildStage: boolean;
  runnerFromLine: number;
}

const MAX_DOCKERFILE_LINE_LENGTH = 2000;

export function safeDockerLine(line: string): string {
  /* v8 ignore next */
  return line.length > MAX_DOCKERFILE_LINE_LENGTH
    ? line.slice(0, MAX_DOCKERFILE_LINE_LENGTH)
    : line;
}

const SECRET_API_KEY_PATTERN =
  /(?:API_KEY|APIKEY|API_SECRET|SECRET_KEY|AUTH_TOKEN|ACCESS_TOKEN)\s{0,10}=\s{0,10}['"]?[\w-]{16,200}/i;
const SECRET_AWS_PATTERN =
  /(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)\s{0,10}=\s{0,10}['"]?[\w/+=]{20,200}/i;
const SECRET_DB_URL_PATTERN =
  /(?:DATABASE_URL|DB_URL|MONGO_URL|REDIS_URL)\s{0,10}=\s{0,10}['"]?[a-z]{1,20}:\/\/[^:]{1,100}:[^@]{1,100}@/i;
const SECRET_PASSWORD_PATTERN =
  /(?:PASSWORD|PASSWD|DB_PASSWORD|ADMIN_PASSWORD)\s{0,10}=\s{0,10}['"]?[^\s'"]{8,200}/i;
const SECRET_PRIVATE_KEY_PATTERN = /-----BEGIN\s{1,10}(?:RSA\s{1,10})?PRIVATE\s{1,10}KEY-----/;
const SECRET_JWT_PATTERN = /JWT_SECRET\s{0,10}=\s{0,10}['"]?[\w-]{32,500}/i;

export const SECRET_PATTERNS = [
  SECRET_API_KEY_PATTERN,
  SECRET_AWS_PATTERN,
  SECRET_DB_URL_PATTERN,
  SECRET_PASSWORD_PATTERN,
  SECRET_PRIVATE_KEY_PATTERN,
  SECRET_JWT_PATTERN,
];

const PNPM_INSTALL_PATTERN = /pnpm\s{1,10}install(?!\s{1,10}--frozen-lockfile)/;
const NPM_INSTALL_PATTERN =
  /npm\s{1,10}(?:install|ci)(?!\s{1,10}-g)(?!\s{1,10}--global)(?!\s{1,10}--ci)(?!\s{1,10}--frozen-lockfile)/;
const YARN_INSTALL_PATTERN =
  /yarn\s{1,10}install(?!\s{1,10}--frozen-lockfile)(?!\s{1,10}--immutable)/;

interface PackageManagerPattern {
  pattern: RegExp;
  manager: string;
  fix: string;
}

export const PACKAGE_MANAGER_PATTERNS: PackageManagerPattern[] = [
  { pattern: PNPM_INSTALL_PATTERN, manager: 'pnpm', fix: '--frozen-lockfile' },
  { pattern: NPM_INSTALL_PATTERN, manager: 'npm', fix: '--ci or npm ci' },
  {
    pattern: YARN_INSTALL_PATTERN,
    manager: 'yarn',
    fix: '--frozen-lockfile or --immutable',
  },
];

export const PKG_INSTALL_PATTERN =
  /(?:pnpm|npm|yarn)\s{1,10}install(?!\s{1,10}-g)(?!\s{1,10}--global)/;

export const PROD_DEPS_FLAG_PATTERN = /(?:--prod\b|--production\b)/;

export const APT_UPGRADE_PATTERN = /apt-get\s{1,10}upgrade/i;
export const COPY_PATTERN = /COPY\s{1,10}(?:--from=\S{1,100}\s{1,10})?(\S{1,500})/i;
export const PACKAGE_FILE_COPY_PATTERN =
  /COPY\s{1,10}[^\n]{0,500}(?:package\.json|pnpm-lock|yarn\.lock|package-lock)/i;
export const NODE_MODULES_FROM_STAGE_PATTERN =
  /COPY\s{1,10}--from=\S{1,100}[^\n]{0,500}node_modules/i;
export const FROM_IMAGE_PATTERN = /FROM\s{1,10}(\S{1,200})/i;
export const FROM_STAGE_PATTERN = /\bAS\s{1,10}(\w{1,100})/i;
export const USER_PATTERN = /USER\s{1,10}(\S{1,100})/i;
export const NODE_ENV_PROD_PATTERN = /NODE_ENV\s{0,10}=\s{0,10}production/i;

export const RUNNER_STAGE_NAMES = new Set(['runner', 'production', 'prod', 'final', 'runtime']);