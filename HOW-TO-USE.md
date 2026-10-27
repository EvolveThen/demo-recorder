# How to use

Turn a Markdown "scene file" into a narrated screen recording of any web
app. You write what the viewer should hear and, inline in brackets, what the
cursor should do at each moment. The recorder drives a headless Chromium,
speaks the narration with ElevenLabs, and muxes picture and voice into an
MP4 — with every cursor move landing at the exact word it belongs to.

## The command

```bash
demo-recorder <scene.md> [--url https://your-app] [--audit]
```

(If you skipped the `--link` step in SETUP.md, run it as
`/path/to/demo-recorder/demo-recorder …` or
`npm run record -- …` from inside the demo-recorder folder.)

| Flag | What it does |
| --- | --- |
| `<scene.md>` | Path to the scene file (any location) |
| `--url <base>` | Base URL for `[go /relative/path]`. Falls back to `BASE_URL` from `.env` if omitted |
| `--audit` | Dry run: no voice, no video — every action runs and a screenshot is saved after each one |

Output: `out/<scene-name>.mp4`. Exit code `0` means clean, `2` means the
video was produced but has problems you should fix (details below), `1`
means it crashed.

## The workflow

**1. Write the scene** — what you'd say while demoing, with bracketed
actions where the cursor should move.

**2. Audit it** — `demo-recorder my-scene.md --url … --audit`.
Every action runs against the real app and a screenshot is saved after each
one in `out/audit/NN-L<line>-<action>.png`. Flip through them to catch a
wrong target or a scroll that lands badly — before spending money on
narration. The audit also prints every HTTP request the app made that
failed (or, for non-GET requests, all of them) so surprises can be traced.

**3. Render it** — same command without `--audit`. Narration is generated
first (cached by text in `cache/`, so unchanged sentences are never
re-billed), then the app is filmed, then ffmpeg muxes the result.

**4. Review it** — `sh frames.sh <name>` pulls a frame just after every
cursor move from the video and tiles them into `out/<name>-sheetNN.png`.
Look at every sheet before sending the video anywhere.

## Scene file format

A Markdown file. Plain text is spoken; `[bracketed]` actions fire at the
exact moment the voice reaches the words that follow them (ElevenLabs
returns per-character timings with the audio).

- Actions **before the first word** of a paragraph run before the voice
  starts — use them to navigate, click into fields, set the stage.
- Actions **after the last word** run when the paragraph's voice ends.
- A blank line ends a paragraph. `#` headings and `<!-- comments -->` are
  ignored (and split paragraphs).

```
[go /invoices] let's look at invoices.

[click button:New invoice] creating one takes a single click,
[type Acme consulting] name it,
[click button:Save] and save.
```

Each paragraph becomes one narration clip; a short breath (~0.45 s) is
inserted between paragraphs.

## Actions

| Action | What it does |
| --- | --- |
| `[go /path]` | Navigate. Relative paths resolve against `--url`/`BASE_URL`; a full `https://…` URL goes there directly |
| `[hover <target>]` | Glide the cursor to the target and rest on it |
| `[click <target>]` | Glide and click |
| `[scrollto <target>]` | Smooth-scroll the target to the upper part of the screen, then hover it |
| `[scroll <px>]` | Scroll by that many pixels (negative = up) |
| `[scroll <px> over <s>]` | The same, spread slowly over N seconds — a read-through of a long page |
| `[type <text>]` | Type into whatever is focused (click a field first) |
| `[press Escape]` | Press a key (`Enter`, `Tab`, `ArrowDown`, …) |
| `[caret start]` / `[caret end]` | Move the caret within the focused text field |
| `[wait <seconds>]` | Pause |
| `[upload <path>]` | Hand a file to the open file chooser. Path relative to the scene file's folder |
| `[run <command>]` | Run a shell command (from the scene file's folder) and wait for it — stage data mid-scene |
| `[runbg <command>]` | Run a shell command and keep talking while it works |

After every `go` and `click`, the recorder waits for the app to stop
loading — network quiet, no spinners, skeletons or "Loading…" text — so the
voice never talks over a loading state.

## Targets

How the recorder finds the thing to point at:

| Target | Matches |
| --- | --- |
| `text:Last heard` | Visible text, case-insensitive, partial match |
| `exact:Timeline` | Visible text, exact match |
| `tab:Calls` | An ARIA tab named "Calls" |
| `button:Columns` | A button whose name contains "Columns" |
| `xbutton:Email` | A button whose name is exactly "Email" — won't match "Plain email" |
| `link:Pricing` | A link |
| `th:Overdue` | A column header |
| `placeholder:Search` | An input by its placeholder |
| `label:Approves quotes` | A field by its label |
| `xlabel:Quantity` | A field by its exact label — won't match "XS quantity" |
| `css:h4:has-text("Rob")` | Any Playwright CSS/XPath selector |
| `testid:submit-btn` | An element by `data-testid` — for icon-only buttons and menu items |

Append `#2` to pick the second match: `text:Invoice#2`. With no kind
prefix, the target is treated as partial text.

## The quality gates

The render refuses to pass (exit 2) when:

- **An action failed** — usually a target that couldn't be found. The
  action is skipped (the video still renders) but the problem is listed at
  the end so you can fix the scene.
- **A pointed-at element sits too low** — if a heading, tab or column
  header the voice is talking about ended up in the lower half of the
  screen, the viewer can't see it. Buttons, fields and things inside
  dialogs get a pass (dialog footers sit low by design); content-bearing
  elements must be in the top ~55% of the screen (top ~70% inside a
  dialog). Fix with `[scrollto]` before the hover, or reword.

## Filming an app that needs a login

There is no built-in auth — the app is filmed exactly as a fresh visitor
sees it. Either script the login inside the scene:

```
[go /login] signing in first.
[click placeholder:Email] [type demo@example.com]
[click placeholder:Password] [type hunter2]
[click button:Sign in] and we're in.
```

…or have the app accept a session via the URL (a token query parameter)
and open it with `[go https://app.example.com/?token=…]`.

## Tips

- **Write like you talk.** Short sentences, one idea per paragraph. Each
  paragraph is one breath of narration.
- **Put navigation before the first word.** `[go …]` at the start of a
  paragraph runs while the screen is silent; the voice starts on a settled
  page.
- **Audit after every app change.** Re-rendering costs ElevenLabs money
  only for sentences whose text changed; the audit is free.
- **Watch for the "running late" warnings.** If an action (a slow page, a
  long `[run]`) takes longer than the words it's synced to, the recorder
  warns and the cursor lands a beat behind the voice. Shorten the sentence
  or split the paragraph.
- **`cache/` is money.** Deleting it forces re-generation of every
  sentence. Leave it alone unless you changed voice or model.
- **`out/render.log`** holds the full timeline of a render; `frames.sh`
  reads it to know where each cursor moment landed in the final video.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `relative [go] needs a base URL` | Pass `--url` or set `BASE_URL` in `.env` |
| `ELEVENLABS_API_KEY not found` | Put the key in `demo-recorder/.env` (see SETUP.md) |
| `locator.waitFor: Timeout 8000ms exceeded` | The target isn't on the page — check spelling, or the app state differs from what the scene assumes. Audit and look at the screenshot just before |
| `sits at NN% of the screen height` | The pointed-at element is too low. Add `[scrollto <target>]` before it, or scroll less |
| Video renders but exit code 2 | Fix the listed problems and re-render — narration for unchanged sentences is free (cached) |
| Cursor doesn't appear | The app must not remove injected elements; the cursor is re-injected on every navigation automatically |
