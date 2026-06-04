# Contributing Guide

## Prerequisites

| Tool    | Version | Purpose                    |
|---------|---------|----------------------------|
| Node.js | >= 20.x | Runtime                    |
| npm     | >= 10.x | Package manager            |
| Docker  | any     | Required for E2E tests     |
| act     | latest  | Run GitHub Actions locally |

```bash
brew install act   # macOS
```

---

## Setup

```bash
git clone https://github.com/uclahs-edtech/microsoft-teams-workflows-webhook-notification.git
cd microsoft-teams-workflows-webhook-notification
npm install
npm run all   # verify everything works
```

---

## Development

1. Edit `src/index.js`
2. Add or update tests in `__tests__/index.test.js`
3. Run the full check — all three steps must pass:

```bash
npm run all   # lint → test:coverage → build
```

> ⚠️ Always commit `dist/index.js` after building. CI will fail if it's out of sync.

---

## Testing

### Unit Tests

```bash
npm test                 # run tests
npm run test:coverage    # run with coverage (80% threshold enforced)
```

### E2E Tests

Create a `.secrets` file in the project root, add the Teams workflow webhook
secret required by the test workflow, and **never commit this file**.

Then run:

```bash
npm run test:e2e
```

Verify that messages 3, 4, 5 arrived in your Teams channel.

| # | Test                  | Teams Send |
|---|-----------------------|------------|
| 1 | Dry Run               | ❌ No      |
| 2 | Invalid URL Rejection | ❌ No      |
| 3 | Basic Notification    | ✅ Yes     |
| 4 | With Button           | ✅ Yes     |
| 5 | Failure Notification  | ✅ Yes     |

---

## Commit Convention

| Prefix      | When to use           |
|-------------|-----------------------|
| `feat:`     | New feature           |
| `fix:`      | Bug fix               |
| `docs:`     | Documentation only    |
| `test:`     | Tests only            |
| `chore:`    | Build, deps, config   |
| `security:` | Security-related fix  |

Breaking changes: add `!` after prefix (e.g. `feat!: rename input`)

---

## Releasing (Maintainers Only)

```bash
npm run all && npm run test:e2e      # must pass

npm version patch|minor|major        # bump version
git add . && git commit -m "chore: release vX.X.X"
git push origin main

git tag -a vX.X.X -m "vX.X.X"
git push origin vX.X.X               # triggers release.yml automatically
```

> Pushing a tag automatically runs `release.yml` which creates the GitHub Release,
> updates the Marketplace, and moves the floating major tag (e.g. `v1`).
