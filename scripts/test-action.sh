#!/bin/bash
# scripts/test-action.sh
# Runs all act-based integration tests before release.
# Usage: ./scripts/test-action.sh
# Requires: .secrets file with TEAMS_WEBHOOK_URL

set -e  # Exit immediately on any error

WORKFLOW=".github/workflows/test.yml"
SECRETS=".secrets"
EVENT=".github/events/changelog-payload.json"
ACT_CMD="act workflow_dispatch -W $WORKFLOW --secret-file $SECRETS -e $EVENT"

# ── Pre-flight checks ────────────────────────────────────────────
echo ""
echo "🔍 Pre-flight checks..."

# Check .secrets file exists
if [ ! -f "$SECRETS" ]; then
  echo "❌ .secrets file not found."
  echo "   Create it with TEAMS_WEBHOOK_URL set to your Teams workflow webhook URL."
  exit 1
fi

# Check event payload exists
if [ ! -f "$EVENT" ]; then
  echo "❌ Event payload not found: $EVENT"
  exit 1
fi

# Check dist/index.js exists
if [ ! -f "dist/index.js" ]; then
  echo "❌ dist/index.js not found. Run 'npm run build' first."
  exit 1
fi

echo "✅ Pre-flight checks passed."
echo ""

# ── Run tests ────────────────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🧪 Test 1/6 — Dry Run (no Teams send)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
$ACT_CMD -j test-dry-run
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔐 Test 2/6 — Security: Invalid URL Rejection"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
$ACT_CMD -j test-invalid-url
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📨 Test 3/6 — Basic Notification (Teams send)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
$ACT_CMD -j test-basic
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔘 Test 4/6 — Notification With Button"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
$ACT_CMD -j test-with-button
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 Test 5/6 — Changelog Payload Notification"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
$ACT_CMD -j test-changelog-payload
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "❌ Test 6/6 — Failure Notification"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
# test-on-failure always exits with code 1 (intentional) — ignore it
$ACT_CMD -j test-on-failure || true
echo ""

# ── Done ─────────────────────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ All integration tests completed!"
echo "   Check your Teams channel to verify messages arrived."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
