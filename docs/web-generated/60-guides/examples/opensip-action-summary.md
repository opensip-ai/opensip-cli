# OpenSIP review: FAIL

- Issues: 2
- New issues: 1
- Degraded: baseline-unavailable

## Top risks
- high no-console-log src/index.ts:3 - Console logging should not ship in production code.
- medium high-blast-untested src/service.ts:42 - Changed function has broad downstream reach without matching tests.
