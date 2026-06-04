# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | ✅ Yes    |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report security issues by emailing: **edtech@mednet.ucla.edu**

Include the following:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You will receive a response within **72 hours**.
Confirmed vulnerabilities will be patched within **14 days**.

## Security Design Decisions

- Webhook URLs are registered with `core.setSecret()` and never appear in logs.
- Only HTTPS webhook URLs pointing to Microsoft Azure domains are accepted (SSRF prevention).
- All text inputs are sanitized and length-limited before being embedded in JSON payloads.
- The action requests only the minimum GitHub token permissions required.
- Dependencies are kept up to date via Dependabot with weekly scans.
- CodeQL static analysis runs on every push and weekly schedule.