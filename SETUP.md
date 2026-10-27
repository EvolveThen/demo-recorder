# Setup

One-time installation for the demo recorder. Everything runs locally; the
only external service is ElevenLabs (narration), and only when you render a
finished video — auditing a scene costs nothing.

## Requirements

- **macOS** (tested) — anything with Node, Chromium and ffmpeg-static works
- **Node.js 20+** and npm
- ~250 MB disk for dependencies and the Chromium build

## Install

One command, from the `demo-recorder` folder:

```bash
sh setup.sh
```

That checks Node 20+, installs the npm dependencies, downloads the
recorder's own headless Chromium (into `~/Library/Caches/ms-playwright/` —
it does not touch your own browser), creates `.env` from `.env.example`,
and prints next steps.

Add `--link` to also put a `demo-recorder` command on your PATH (needs
sudo; it prints the manual command if it can't):

```bash
sh setup.sh --link
```

After that, record from **any** directory:

```bash
demo-recorder my-scene.md --url http://localhost:5173
```

### Manual install (equivalent)

```bash
cd demo-recorder
npm install
npx playwright install chromium
cp .env.example .env
```

### Windows

The recorder itself is cross-platform, but the `setup.sh` installer and
`demo-recorder` launcher are shell scripts — run them from **Git Bash**
(included with Git for Windows) or WSL. Without a shell, the npm route
works everywhere:

```bat
cd demo-recorder
npm install
npx playwright install chromium
copy .env.example .env
npm run record -- my-scene.md --url http://localhost:5173
```

## Configure `.env`

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `ELEVENLABS_API_KEY` | for rendering | — | ElevenLabs key, used to generate the narration. Get one at [elevenlabs.io](https://elevenlabs.io) → Profile → API Keys. Audits run without it. |
| `BASE_URL` | no | — | Default base URL for `[go /relative/path]` targets, so you can omit `--url` on the command line. |
| `ELEVENLABS_VOICE_ID` | no | `E8f8Zp0iARTamRzjNG4H` | Which voice narrates. Pick any voice ID from your ElevenLabs dashboard. |
| `ELEVENLABS_MODEL_ID` | no | `eleven_multilingual_v2` | Narration model. `eleven_turbo_v2_5` is cheaper/faster; `eleven_multilingual_v2` sounds best. |

Values can also be set as normal environment variables; `.env` wins over
nothing, the environment wins over `.env`.

## Verify the installation

Serve a test page and audit a scene against it (no API key needed):

```bash
mkdir -p /tmp/demo-test && cat > /tmp/demo-test/index.html <<'EOF'
<!doctype html><html><body><h1>Hello</h1>
<input placeholder="Search"><button>Go</button></body></html>
EOF
python3 -m http.server 8931 --directory /tmp/demo-test &
```

Write a tiny scene (see HOW-TO-USE.md for the format):

```markdown
# Smoke test

[go /] the test page loads.

[hover css:h1] the heading is at the top.
```

Save it as `smoke.scene.md` anywhere, then:

```bash
demo-recorder smoke.scene.md --url http://localhost:8931 --audit
```

You should see `Audit done: 2 screenshots in …/out/audit` and exit code 0.
Open the two PNGs in `out/audit/` — the page with the cursor resting on the
heading is what a real video would show.

Stop the test server when done:

```bash
kill %1
```

## Folder layout

```
demo-recorder/
├── record.ts        the recorder (single file, no build step)
├── demo-recorder    launcher — run it from any directory
├── setup.sh         one-command installer
├── frames.sh        contact-sheet generator for reviewing a finished video
├── out/             rendered videos, audit screenshots, render.log
├── cache/           narration clips, cached by text — safe to delete,
│                    but deleting means re-billing unchanged sentences
└── .env             your ElevenLabs key and defaults (never commit it)
```
