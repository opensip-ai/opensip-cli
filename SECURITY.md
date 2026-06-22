# Security Policy

## Reporting A Vulnerability

If you discover a security vulnerability in OpenSIP CLI, please report it
privately.

Do not open a public GitHub issue for security vulnerabilities.

## How To Report

1. Use GitHub private vulnerability reporting:
   <https://github.com/opensip-ai/opensip-cli/security/advisories/new>
2. Email admin@opensip.ai

## What To Include

- Description of the vulnerability.
- Steps to reproduce.
- Affected versions, packages, or commands.
- Potential impact.
- Suggested fix, if you have one.

## Response Timeline

- Acknowledgment: within 48 hours.
- Initial assessment: within 5 business days.
- Fix timeline: based on severity, with critical issues prioritized.

## Scope

This policy covers the `opensip-cli` package, the `opensip` command, and the
first-party `@opensip-cli/*` packages in this repository.

Out of scope:

- Community plugins installed with `opensip fit plugin add` / `opensip sim plugin add`.
- Vulnerabilities in upstream dependencies, unless OpenSIP CLI usage creates a
  distinct exploitable path.

## Supported Release

| Version | Supported |
| ------- | --------- |
| 0.1.9   | Yes       |
We recommend running the latest `opensip-cli` release.
