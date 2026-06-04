# MS Teams Workflows Webhook Notification

[![CI](https://github.com/uclahs-edtech/microsoft-teams-workflows-webhook-notification/actions/workflows/ci.yml/badge.svg)](https://github.com/uclahs-edtech/microsoft-teams-workflows-webhook-notification/actions/workflows/ci.yml)
[![CodeQL](https://github.com/uclahs-edtech/microsoft-teams-workflows-webhook-notification/actions/workflows/codeql.yml/badge.svg)](https://github.com/uclahs-edtech/microsoft-teams-workflows-webhook-notification/actions/workflows/codeql.yml)

Send notifications from GitHub Actions to Microsoft Teams using the new
**Power Automate Workflow incoming webhook** — the replacement for the
deprecated Office 365 Connectors.

## Usage

```yaml
- name: Notify Teams
  uses: uclahs-edtech/microsoft-teams-workflows-webhook-notification@v1
  with:
    webhook-url: ${{ secrets.TEAMS_WEBHOOK_URL }}
    title: '✅ Deployment Succeeded'
    message: 'Successfully deployed to production.'
    payload: ${{ toJson(job) }}
    button-text: 'View Run'
    button-url: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
```

## Setting Up the Webhook URL

1. In Microsoft Teams, go to your channel → **Workflows**.
2. Search for **"Post to a channel when a webhook request is received"**.
3. Select the target team and channel, then click **Save**.
4. Copy the generated webhook URL.
5. Add it to your repository as a secret: **Settings → Secrets → `TEAMS_WEBHOOK_URL`**.

## Inputs

| Input                   | Required | Default              | Description                                        |
|-------------------------|----------|----------------------|----------------------------------------------------|
| `webhook-url`           | ✅       | —                    | Teams Workflow webhook URL (store in Secrets)      |
| `title`                 | ❌       | `GitHub Notification`| Card title                                         |
| `message`               | ✅       | —                    | Notification message body                          |
| `payload`               | ❌       | —                    | Optional detail payload; JSON is pretty-printed    |
| `color`                 | ❌       | `#0078D4`            | Accent color (Message Card only)                   |
| `include-github-context`| ❌       | `true`               | Include repo, ref, actor, workflow facts           |
| `button-text`           | ❌       | —                    | Action button label                                |
| `button-url`            | ❌       | —                    | Action button URL (HTTPS only)                     |
| `card-type`             | ❌       | `adaptive`           | `adaptive` (recommended) or `message` (legacy)     |
| `dry-run`               | ❌       | `false`              | Build payload without sending                      |

## Outputs

| Output   | Description                          |
|----------|--------------------------------------|
| `status` | HTTP response status code from Teams |

## Examples

### Notify on failure only

```yaml
- name: Notify Teams on failure
  if: failure()
  uses: uclahs-edtech/microsoft-teams-workflows-webhook-notification@v1
  with:
    webhook-url: ${{ secrets.TEAMS_WEBHOOK_URL }}
    title: '❌ Build Failed'
    message: 'Pipeline failed on `${{ github.ref_name }}`.'
    payload: ${{ toJson(job) }}
    color: '#D13438'
    button-text: 'View Logs'
    button-url: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
```

### Always notify with status

```yaml
- name: Notify Teams
  if: always()
  uses: uclahs-edtech/microsoft-teams-workflows-webhook-notification@v1
  with:
    webhook-url: ${{ secrets.TEAMS_WEBHOOK_URL }}
    title: ${{ job.status == 'success' && '✅ Success' || '❌ Failed' }}
    message: 'Workflow `${{ github.workflow }}` finished with status: **${{ job.status }}**'
```

## Security

- Webhook URLs are masked in all logs via `core.setSecret()`.
- Only HTTPS URLs on Microsoft Azure domains are accepted (SSRF prevention).
- See [SECURITY.md](SECURITY.md) for the full security policy.

## License

MIT
