# demo-recorder

Turns a scene file into a narrated screen recording of **any web app** —
local or on the internet. A headless Chromium drives the UI, an animated
cursor points and clicks, ElevenLabs reads the narration, and ffmpeg
stitches picture and voice into an MP4. Re-run after any UI or wording
change and a fresh video comes out.

```
demo-recorder my-scene.md --url http://localhost:5173
```

## Documentation

- **[SETUP.md](SETUP.md)** — one-time installation, `.env` configuration,
  and a smoke test to verify everything works.
- **[HOW-TO-USE.md](HOW-TO-USE.md)** — the scene file format, every action
  and target, the write → audit → render → review workflow, and
  troubleshooting.

## The short version

1. **Write a scene**: a Markdown file where plain text is what the voice
   says and `[bracketed]` actions are what the cursor does at that moment.

   ```
   [go /invoices] let's look at invoices.

   [click button:New invoice] creating one takes a single click.
   ```

2. **Audit it** (free, no API key): every action runs and a screenshot is
   saved after each one, so you can catch wrong targets before paying for
   narration.

   ```
   demo-recorder my-scene.md --url http://localhost:5173 --audit
   ```

3. **Render it**: narration is generated with ElevenLabs (cached by text,
   so unchanged sentences are never re-billed) and muxed into
   `out/my-scene.mp4`.

4. **Review it**: `sh frames.sh my-scene` tiles a frame from just after
   every cursor move into contact sheets — look at every sheet before
   sending.

No login support: the app is filmed exactly as a fresh visitor sees it.
If the app needs a session, script the login inside the scene (see
HOW-TO-USE.md).

A runnable example lives in `examples/` — a tiny site plus a scene that
drives it:

```bash
python3 -m http.server 8931 --directory examples/example-site &
demo-recorder examples/example.scene.md --url http://localhost:8931 --audit
```
