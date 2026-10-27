#!/bin/sh
# One-command setup for demo-recorder.
#   sh setup.sh          install everything
#   sh setup.sh --link   also put a `demo-recorder` command on your PATH
set -e
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"

# 1. Node 20+
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js is not installed. Install it from https://nodejs.org (20 or newer) and re-run."
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 20 ]; then
  echo "✗ Node $(node -v) found; 20 or newer is required."
  exit 1
fi
echo "✓ Node $(node -v)"

# 2. Dependencies + the recorder's own Chromium
echo "Installing dependencies…"
npm install --no-fund --no-audit
echo "Installing headless Chromium (does not touch your own browser)…"
npx playwright install chromium
echo "✓ Dependencies ready"

# 3. .env from the example, never overwriting an existing one
if [ -f .env ]; then
  echo "✓ .env already exists (left untouched)"
else
  cp .env.example .env
  echo "✓ Created .env from .env.example — add your ELEVENLABS_API_KEY before rendering"
fi

# 4. Launcher
chmod +x demo-recorder
if [ "$1" = "--link" ]; then
  if ln -sf "$here/demo-recorder" /usr/local/bin/demo-recorder 2>/dev/null; then
    echo "✓ Installed: run 'demo-recorder' from any directory"
  else
    echo "✗ Could not write to /usr/local/bin. Run this manually:"
    echo "    sudo ln -sf \"$here/demo-recorder\" /usr/local/bin/demo-recorder"
  fi
else
  echo
  echo "Optional — run the recorder from any directory:"
  echo "    sudo ln -sf \"$here/demo-recorder\" /usr/local/bin/demo-recorder"
fi

echo
echo "Done. Next steps:"
echo "  1. Put your ElevenLabs key in $here/.env (ELEVENLABS_API_KEY=…)"
echo "  2. Write a scene file (see HOW-TO-USE.md)"
echo "  3. Audit it:  $here/demo-recorder my-scene.md --url http://localhost:5173 --audit"
echo "     or render: $here/demo-recorder my-scene.md --url http://localhost:5173"
