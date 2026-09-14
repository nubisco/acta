# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |
| < 1.0   | No        |

Acta is distributed as a container image and as source. "Supported" means
security fixes are released for it; it does not mean older images are patched
in place. Pull the current image.

## Reporting a vulnerability

Please report suspected vulnerabilities privately.

- Preferred: GitHub private vulnerability reporting (the repository's Security tab)
- Alternative: email security@nubisco.io with the subject `Security: acta`

Please do not open a public issue for a security report before disclosure is
coordinated.

## What to include

- The affected version or commit
- A clear description of the issue and its impact
- Steps to reproduce, or proof-of-concept details
- Relevant stack traces, configuration, or request/response pairs
- Any suggested mitigation, if you have one

## Scope

In scope:

- The server: REST API (`/api/v1`), MCP endpoint (`/mcp`), the ingest endpoint,
  webhook delivery and signature verification
- Authentication and session handling: one-time codes, OpenID Connect, the JWT
  handover contract, personal and agent access tokens
- Authorization: anything that lets a token reach data or an action it should
  not, including a personal token reaching administrative functions
- The rules kernel, where a crafted rule escapes its attribution or loop guard
- The import CLIs, where hostile input from an export file affects the importing
  instance
- Stored or reflected XSS through item descriptions, comments or documents,
  including the enhanced-Markdown extensions
- Dependency vulnerabilities with practical impact on a running instance

Out of scope:

- Unsupported versions
- An instance running with the default one-time-code sender, which prints codes
  to the log. This is documented as unsuitable for anything but a first boot,
  and it is a configuration choice rather than a vulnerability
- Self-hosted deployments exposed without TLS. Acta sets `Secure` on its session
  cookie and expects to be reached over HTTPS
- Findings that require an administrator acting against their own instance
- General hardening suggestions with no concrete vulnerability
- Denial of service through sheer volume against an instance you control

## Response expectations

Acta is maintained by a small team.

- We aim to acknowledge a valid report within 7 business days
- Triage and remediation depend on severity and maintainer availability
- We may ask for more detail in order to reproduce
- Credit is given in the release notes unless you prefer to stay anonymous
