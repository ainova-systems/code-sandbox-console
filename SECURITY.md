# Security Policy

## Reporting a vulnerability

Report vulnerabilities **privately** through GitHub Security Advisories:

<https://github.com/ainova-systems/code-sandbox-console/security/advisories/new>

That form is the only reporting channel. Include the extension version, your OS and
VS Code version, the `sbx` version, and the steps needed to reproduce the issue.

We aim to acknowledge a report within 5 business days and to ship a fix or state a
mitigation timeline within 30 days.

**Never open a public issue for a security report, and never include vulnerability
details in one.** This extension provisions credentials (`sbx secret set`,
`gh auth login`), so responsible disclosure matters.

## Supported versions

| Version                                        | Supported          |
| ---------------------------------------------- | ------------------ |
| Latest release published on the VS Code Marketplace | Yes, best effort |
| Any earlier release                            | No                 |

Fixes are shipped only in a new Marketplace release; there are no backports to older
versions, and sideloaded `.vsix` builds are not serviced. Pre-1.0 releases receive
security fixes on a best-effort basis.
