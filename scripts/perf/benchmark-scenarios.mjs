export function scenarioArgs(scenario, graphProfilePath, changedFile) {
  switch (scenario) {
    case 'fit-full': {
      return ['fit', '--json'];
    }
    case 'fit-changed': {
      return ['fit', '--changed', '--json'];
    }
    case 'graph-cold':
    case 'graph-warm': {
      return ['graph', '--json', '--profile', graphProfilePath];
    }
    case 'graph-exact': {
      return ['graph', '--resolution', 'exact', '--json', '--profile', graphProfilePath];
    }
    case 'graph-fast': {
      return ['graph', '--resolution', 'fast', '--json', '--profile', graphProfilePath];
    }
    case 'graph-impact-files': {
      return ['graph', 'impact', '--files', changedFile, '--top', '20', '--json'];
    }
    case 'audit-changed': {
      return ['suite', 'run', 'audit', '--changed', '--json'];
    }
    case 'cli-help': {
      return ['--help'];
    }
    case 'report-generate': {
      return ['report', '--no-open', '--json'];
    }
    default: {
      throw new Error(`Unsupported performance scenario '${scenario}'.`);
    }
  }
}

export function scenarioNeedsGraphCatalog(scenario) {
  return (
    scenario === 'graph-warm' || scenario === 'graph-impact-files' || scenario === 'audit-changed'
  );
}

export function scenarioRequiresGit(scenario) {
  return scenario === 'fit-changed' || scenario === 'audit-changed';
}

export function scenarioResetsRuntime(scenario) {
  return scenario === 'graph-cold' || scenario === 'graph-exact' || scenario === 'graph-fast';
}

export function scenarioNeedsReportSession(scenario) {
  return scenario === 'report-generate';
}
