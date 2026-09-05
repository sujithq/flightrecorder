# Security Policy

## Supported versions

Agent Flight Recorder is currently under active development. Security fixes are applied to the latest revision of the `main` branch.

| Version | Supported |
| --- | --- |
| Latest `main` | Yes |
| Older revisions | No |

## Reporting a vulnerability

Please report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/sujithq/flightrecorder/security/advisories/new).

Do not disclose the vulnerability in a public issue, discussion, pull request, or recorded Flight Recorder trace.

Include only the information needed to reproduce and assess the issue:

- Affected component and version or commit
- Reproduction steps or proof of concept
- Expected and observed behavior
- Potential impact
- Suggested remediation, if known

Remove credentials, access tokens, personal information, and unrelated proprietary data before submitting a report. Maintainers will triage the report, coordinate remediation, and discuss disclosure timing through the private advisory.

## Security considerations for deployments

The current MCP endpoint is unauthenticated and intended for trusted local development. Do not expose it to an untrusted network without adding authentication, authorization, transport security, and durable secret-safe storage.
