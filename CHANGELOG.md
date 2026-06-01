# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-06-01

### Added
- Initial release of MS Teams Workflow Webhook Notification action.
- Adaptive Card support (new Power Automate Workflow webhook format).
- Legacy Message Card support as fallback (`card-type: message`).
- Automatic GitHub context facts (repo, ref, actor, workflow, run number).
- Optional action button with HTTPS-only URL validation.
- SSRF prevention via Azure domain allowlist.
- Webhook URL masking via `core.setSecret()`.
- Input sanitization and length limits for all text fields.
- `dry-run` mode for payload verification without sending.
- Request timeout (10 seconds) to prevent hanging workflows.