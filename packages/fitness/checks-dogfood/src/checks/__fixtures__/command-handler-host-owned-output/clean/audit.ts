export interface AuditResult {
  readonly passed: boolean;
  readonly findings: number;
}

export async function runAudit(_cwd: string): Promise<AuditResult> {
  return { passed: true, findings: 0 };
}
