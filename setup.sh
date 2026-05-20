#!/bin/bash
set -e

echo ""
echo "╔══════════════════════════════════════╗"
echo "║         CastHub Setup                ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── Dependency checks ──────────────────────────────────────────────
command -v node >/dev/null 2>&1 || { echo "❌  Node.js not found. Install from https://nodejs.org"; exit 1; }
command -v gh   >/dev/null 2>&1 || { echo "❌  GitHub CLI not found. Run: winget install GitHub.cli"; exit 1; }
echo "✅  Node $(node -v) · gh $(gh --version | head -1 | awk '{print $3}')"

# ── Git init ───────────────────────────────────────────────────────
echo ""
echo "📁  Initializing git..."
git init
git add .
git commit -m "feat: initial CastHub implementation"

# ── GitHub repo ────────────────────────────────────────────────────
echo ""
echo "🐙  Creating GitHub repository..."
gh repo create westcal98/casthub \
  --public \
  --description "Local media caster for Chromecast with mobile remote" \
  --source . \
  --remote origin \
  --push
echo "✅  https://github.com/westcal98/casthub"

# ── npm install ────────────────────────────────────────────────────
echo ""
echo "📦  Installing npm dependencies..."
npm install
echo "✅  Dependencies installed"

# ── Cloudflare Pages (mobile PWA) ─────────────────────────────────
echo ""
echo "☁️   Deploying mobile PWA to Cloudflare Pages..."
echo "    (You may be prompted to log in to Cloudflare)"
npx wrangler pages deploy mobile --project-name casthub-mobile
echo "✅  Mobile PWA live"

# ── Done ───────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ✅  CastHub is ready!                               ║"
echo "║                                                      ║"
echo "║  Desktop app →  npm start                            ║"
echo "║  Mobile PWA  →  https://casthub-mobile.pages.dev    ║"
echo "║                                                      ║"
echo "║  ⚠️  Windows firewall: allow ports 8765 and 8766     ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
