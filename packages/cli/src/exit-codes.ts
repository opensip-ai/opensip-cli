export const EXIT_CODES = {
  SUCCESS: 0,
  RUNTIME_ERROR: 1,
  CONFIGURATION_ERROR: 2,
  CHECK_NOT_FOUND: 3,
  REPORT_FAILED: 4,
} as const;

export interface ErrorSuggestion {
  message: string;
  action?: string;
  exitCode: number;
}

export function getErrorSuggestion(err: unknown): ErrorSuggestion | null {
  const message = err instanceof Error ? err.message : String(err);

  // Check not found
  if (message.includes('Check not found:') || message.includes('not found')) {
    const slug = message.match(/Check not found: (.+)/)?.[1] ?? message.match(/not found: (.+)/)?.[1];
    return {
      message: `Check '${slug ?? 'unknown'}' not found.`,
      action: 'Run opensip-tools fit --list to see available checks.',
      exitCode: EXIT_CODES.CHECK_NOT_FOUND,
    };
  }

  // Recipe not found
  if (message.includes('Unknown recipe')) {
    return {
      message: message,
      action: 'Run opensip-tools fit --recipes to see available recipes.',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    };
  }

  // Config file error
  if (message.includes('opensip-tools.config.yml') || message.includes('YAML') || message.includes('config')) {
    return {
      message: 'Configuration error.',
      action: 'Check opensip-tools.config.yml for syntax errors.',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    };
  }

  // Permission denied
  if (message.includes('EACCES') || message.includes('permission denied')) {
    return {
      message: 'Permission denied reading files.',
      action: 'Check file permissions in the target directory.',
      exitCode: EXIT_CODES.RUNTIME_ERROR,
    };
  }

  // No files found
  if (message.includes('No checks registered') || message.includes('No checks to run')) {
    return {
      message: 'No checks available to run.',
      action: 'Ensure @opensip-tools/checks-builtin is installed.',
      exitCode: EXIT_CODES.RUNTIME_ERROR,
    };
  }

  // Network error (report-to)
  if (message.includes('fetch') || message.includes('ECONNREFUSED') || message.includes('network')) {
    return {
      message: 'Network error sending report.',
      action: 'Check the --report-to URL and your network connection.',
      exitCode: EXIT_CODES.REPORT_FAILED,
    };
  }

  return null;
}
