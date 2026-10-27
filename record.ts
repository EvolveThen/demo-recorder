/**
 * Standalone demo recorder for any web app.
 *
 *   npm run record -- <scene.md> [--url https://your-app] [--audit]
 *
 * Reads a scene file (see README.md), films a headless Chromium driving the
 * app at --url (or BASE_URL from .env), performs every action with a visible
 * animated cursor at the exact moment the narration reaches it, records the
 * screen with Playwright, then muxes voice and picture into out/<name>.mp4
 * with ffmpeg. Narration clips (and their word timings) are cached by text,
 * so unchanged sentences are never generated twice.
 */
import { chromium, type Page, type Locator } from 'playwright';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

// ── env ───────────────────────────────────────────────────────────────────────
async function loadEnv(file: string): Promise<Record<string, string>> {
  try {
    const out: Record<string, string> = {};
    for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
  } catch { return {}; }
}
const env = { ...(await loadEnv(path.join(here, '.env'))), ...process.env } as Record<string, string>;
const VOICE_ID = env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // ElevenLabs premade "Rachel"
const MODEL_ID = env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
const WIDTH = 1920, HEIGHT = 1080;
const TAIL_MS = 450; // breath after each paragraph

// ── scene file ────────────────────────────────────────────────────────────────
interface Action { kind: string; arg: string; line: number }
/** Actions anchored to a character offset in the paragraph text (0 = before speech starts). */
interface Anchor { offset: number; actions: Action[] }
interface Paragraph { text: string; anchors: Anchor[] }

function parseScene(source: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let text = '';
  let anchors: Anchor[] = [];
  const flush = () => {
    if (text.trim() || anchors.length) paragraphs.push({ text: text.trim(), anchors });
    text = ''; anchors = [];
  };
  const lines = source.split('\n');
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('<!--')) { flush(); return; }
    // Walk the line: [actions] anchor at the text position where they sit.
    let i = 0, buf = '';
    const commit = () => { if (buf) { text += (text && !text.endsWith(' ') ? ' ' : '') + buf.trim(); buf = ''; } };
    while (i < line.length) {
      if (line[i] === '[') {
        const end = line.indexOf(']', i);
        if (end === -1) throw new Error(`Line ${idx + 1}: unclosed [action`);
        commit();
        const m = line.slice(i + 1, end).trim().match(/^(\w+)\s*(.*)$/);
        if (!m) throw new Error(`Line ${idx + 1}: bad action`);
        const offset = text.trim().length;
        const last = anchors[anchors.length - 1];
        const action = { kind: m[1].toLowerCase(), arg: m[2].trim(), line: idx + 1 };
        if (last && last.offset === offset) last.actions.push(action); else anchors.push({ offset, actions: [action] });
        i = end + 1;
      } else { buf += line[i]; i++; }
    }
    commit();
  });
  flush();
  return paragraphs;
}

// ── narration (with character timings) ───────────────────────────────────────
interface Clip { file: string; ms: number; starts: number[] }

async function narrate(text: string, cacheDir: string): Promise<Clip> {
  const key = createHash('sha1').update(`${VOICE_ID}|${MODEL_ID}|ts|${text}`).digest('hex');
  const file = path.join(cacheDir, `${key}.mp3`), meta = path.join(cacheDir, `${key}.json`);
  let starts: number[];
  try {
    starts = JSON.parse(await fs.readFile(meta, 'utf8')).starts;
    await fs.access(file);
  } catch {
    const apiKey = env.ELEVENLABS_API_KEY;
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY not found in demo-recorder/.env or the environment');
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/with-timestamps?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: MODEL_ID, voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true } }),
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json() as { audio_base64: string; alignment: { characters: string[]; character_start_times_seconds: number[] } };
    await fs.writeFile(file, Buffer.from(body.audio_base64, 'base64'));
    // One start time per character of the text we sent (the alignment is over that same text).
    starts = body.alignment.character_start_times_seconds;
    await fs.writeFile(meta, JSON.stringify({ text, starts }));
  }
  const { stdout } = await run(ffprobeStatic.path, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  return { file, ms: Math.round(parseFloat(stdout.trim()) * 1000), starts };
}

/** When (ms into the clip) the voice reaches this character of the paragraph. */
function timeAt(clip: Clip, offset: number): number {
  if (offset <= 0) return 0;
  if (offset >= clip.starts.length) return clip.ms;
  return Math.round(clip.starts[offset] * 1000);
}

// ── cursor overlay (injected into every document) ─────────────────────────────
const CURSOR_SCRIPT = `
(() => {
  if (window.__demoCursor) return;
  const style = document.createElement('style');
  style.textContent = '*{cursor:none!important}' +
    '#__demo-cursor{position:fixed;left:0;top:0;width:28px;height:36px;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}' +
    '#__demo-ripple{position:fixed;width:44px;height:44px;border-radius:50%;border:3px solid #2563eb;z-index:2147483646;pointer-events:none;opacity:0;transform:translate(-50%,-50%) scale(.3)}' +
    '#__demo-ripple.go{animation:__demoRipple .45s ease-out}' +
    '@keyframes __demoRipple{0%{opacity:.9;transform:translate(-50%,-50%) scale(.3)}100%{opacity:0;transform:translate(-50%,-50%) scale(1.1)}}';
  const cur = document.createElement('div');
  cur.id = '__demo-cursor';
  cur.innerHTML = '<svg viewBox="0 0 28 36" width="28" height="36"><path d="M3 2 L3 27 L9.5 21.5 L14 31 L18.5 29 L14 19.5 L22.5 19.5 Z" fill="#111" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>';
  const rip = document.createElement('div');
  rip.id = '__demo-ripple';
  const mount = () => { document.documentElement.appendChild(style); document.documentElement.appendChild(cur); document.documentElement.appendChild(rip); };
  if (document.documentElement) mount(); else document.addEventListener('DOMContentLoaded', mount);
  let x = window.__demoCursorX ?? 960, y = window.__demoCursorY ?? 540;
  const place = () => { cur.style.transform = 'translate(' + (x - 4) + 'px,' + (y - 2) + 'px)'; };
  place();
  window.addEventListener('mousemove', (e) => { x = e.clientX; y = e.clientY; window.__demoCursorX = x; window.__demoCursorY = y; place(); }, true);
  window.addEventListener('mousedown', (e) => { rip.style.left = e.clientX + 'px'; rip.style.top = e.clientY + 'px'; rip.classList.remove('go'); void rip.offsetWidth; rip.classList.add('go'); }, true);
  window.__demoCursor = true;
})();`;

// ── actions ───────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const execShell = promisify((await import('node:child_process')).exec);
async function runShell(cmd: string, timeout: number, cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execShell(cmd, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 });
}
let mouse = { x: 960, y: 540 };
/** Placement failures: a pointed-at element that ended up low or off screen. A render with any of these fails. */
const placement: string[] = [];
let currentAction: Action | null = null;

/** After pointing at something, prove it sits where a viewer can see it AND what follows it. */
async function assertPlacement(loc: Locator) {
  // A button, field or checkbox is fine wherever it is (dialog footers sit at the bottom by design);
  // anything that introduces content below it — headings, tabs, column headers, text — must sit high.
  if (currentAction && /^(button|xbutton|placeholder|label|xlabel|testid):/i.test(currentAction.arg)) return;
  const r = await loc.evaluate((el) => {
    const b = el.getBoundingClientRect();
    // A dropdown, popover or menu is pinned to its trigger (position: fixed) and can only open where the trigger is.
    let popover = false;
    for (let n: HTMLElement | null = el as HTMLElement; n && n !== document.body; n = n.parentElement) {
      if (n.getAttribute('role') === 'dialog') break;
      if (getComputedStyle(n).position === 'fixed') { popover = true; break; }
    }
    return { top: b.top, bottom: b.bottom, vh: window.innerHeight, inDialog: !!el.closest('[role="dialog"]'), popover };
  }).catch(() => null);
  if (!r || (r.popover && !r.inDialog)) return;
  const ratio = r.top / r.vh;
  // A dialog is centred and compact: its last section can only sit around two-thirds down, fully visible.
  const limit = r.inDialog ? 0.7 : 0.55;
  if (r.bottom < 0 || ratio > limit || (r.top < 40 && r.bottom < 40)) {
    placement.push(`line ${currentAction?.line} [${currentAction?.kind} ${currentAction?.arg}] sits at ${Math.round(ratio * 100)}% of the screen height — must be in the top ${Math.round(limit * 100)}%`);
  }
}

function target(page: Page, spec: string): Locator {
  const m = spec.match(/^(.*?)(?:#(\d+))?$/)!;
  const [, body, nth] = m;
  const [kind, ...rest] = body.split(':');
  const value = rest.join(':').trim();
  let loc: Locator;
  switch (kind.toLowerCase()) {
    case 'text': loc = page.getByText(value, { exact: false }); break;
    case 'exact': loc = page.getByText(value, { exact: true }); break;
    case 'tab': loc = page.getByRole('tab', { name: value, exact: true }); break;
    case 'button': loc = page.getByRole('button', { name: value }); break;
    case 'xbutton': loc = page.getByRole('button', { name: value, exact: true }); break; // the whole name — 'Email' must not match 'Plain email'
    case 'link': loc = page.getByRole('link', { name: value }); break;
    case 'th': loc = page.locator('th', { hasText: value }); break;
    case 'placeholder': loc = page.getByPlaceholder(value); break;
    case 'label': loc = page.getByLabel(value); break;
    case 'xlabel': loc = page.getByLabel(value, { exact: true }); break; // the whole label — 'S quantity' must not match 'XS quantity'
    case 'css': loc = page.locator(value); break;
    case 'testid': loc = page.getByTestId(value); break; // data-testid — for icon-only buttons and menu items
    default: loc = page.getByText(body, { exact: false });
  }
  return nth ? loc.nth(parseInt(nth, 10) - 1) : loc.first();
}

async function glide(page: Page, x: number, y: number) {
  const dist = Math.hypot(x - mouse.x, y - mouse.y);
  const steps = Math.max(12, Math.min(60, Math.round(dist / 18)));
  for (let i = 1; i <= steps; i++) {
    const t = (1 - Math.cos((i / steps) * Math.PI)) / 2; // ease in / out
    await page.mouse.move(mouse.x + (x - mouse.x) * t, mouse.y + (y - mouse.y) * t);
    await sleep(14);
  }
  mouse = { x, y };
}

/** Wait until the page's scroll position has stopped moving (smooth scrolls race fixed sleeps otherwise). */
async function scrollSettled(page: Page, maxMs = 2500) {
  const until = Date.now() + maxMs;
  let last = -1;
  while (Date.now() < until) {
    const y = await page.evaluate(() => window.scrollY).catch(() => -1);
    if (y === last && y !== -1) return;
    last = y;
    await sleep(120);
  }
}

/**
 * Bring the target to the upper part of the screen so whatever sits UNDER it
 * (the section a heading introduces, the rows under a column header) is what
 * the viewer sees. Scrolls the nearest scrollable ancestor (a dialog body) or
 * the page, smoothly. `fraction` = where the target should land, as a share
 * of the viewport height from the top.
 */
async function reveal(page: Page, loc: Locator, fraction = 0.2) {
  await loc.waitFor({ state: 'visible', timeout: 8_000 });
  await loc.scrollIntoViewIfNeeded();
  const moved = await loc.evaluate((el, frac) => {
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const want = vh * frac;
    // Already sitting in the comfortable band? Leave the page alone.
    if (rect.top >= 60 && rect.top <= vh * 0.45) return 0;
    let node: HTMLElement | null = el.parentElement;
    let scroller: HTMLElement | null = null;
    while (node) {
      const st = getComputedStyle(node);
      if (/(auto|scroll)/.test(st.overflowY) && node.scrollHeight > node.clientHeight + 4) { scroller = node; break; }
      node = node.parentElement;
    }
    const delta = rect.top - want;
    if (scroller) scroller.scrollBy({ top: delta, behavior: 'smooth' }); else window.scrollBy({ top: delta, behavior: 'smooth' });
    return delta;
  }, fraction);
  if (moved) { await scrollSettled(page); await sleep(150); }
}

async function moveTo(page: Page, loc: Locator, settle = 350) {
  await reveal(page, loc, 0.22);
  const box = await loc.boundingBox();
  if (!box) throw new Error('target has no box');
  await glide(page, box.x + Math.min(box.width / 2, 120), box.y + box.height / 2);
  await assertPlacement(loc);
  await sleep(settle);
}

/**
 * After a navigation or a click, wait until the screen has stopped loading:
 * network quiet, and no "Loading…" text, spinner or skeleton pulse visible.
 * The voice must never talk over a loading state.
 */
async function settle(page: Page, maxMs = 6000) {
  await page.waitForLoadState('networkidle', { timeout: Math.min(maxMs, 4000) }).catch(() => {});
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    const busy = await page.evaluate(() => {
      const vis = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight; };
      if ([...document.querySelectorAll('.animate-pulse, .animate-spin, [aria-busy="true"]')].some(vis)) return true;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = walker.nextNode())) {
        const t = (n.textContent || '').trim();
        if (/^Loading\b|^Loading…|…$/.test(t) && /Loading/i.test(t) && n.parentElement && vis(n.parentElement)) return true;
      }
      return false;
    }).catch(() => false);
    if (!busy) return;
    await sleep(150);
  }
}

async function perform(page: Page, a: Action, baseUrl: string, sceneDir: string) {
  switch (a.kind) {
    case 'go': {
      // [go /path] resolves against --url / BASE_URL; [go https://…] goes there directly.
      const url = /^https?:\/\//i.test(a.arg) ? a.arg : baseUrl ? `${baseUrl.replace(/\/$/, '')}${a.arg.startsWith('/') ? a.arg : `/${a.arg}`}` : '';
      if (!url) throw new Error('relative [go] needs a base URL: pass --url or set BASE_URL in .env');
      await page.goto(url, { waitUntil: 'networkidle' });
      await settle(page);
      await sleep(400);
      break;
    }
    case 'hover': await moveTo(page, target(page, a.arg), 350); break;
    case 'click': {
      await moveTo(page, target(page, a.arg), 220);
      await page.mouse.down(); await sleep(90); await page.mouse.up();
      await sleep(350);
      await settle(page);
      await sleep(250);
      break;
    }
    case 'scrollto': {
      // Land the target near the top of the screen so the section it heads is in view.
      const loc = target(page, a.arg);
      await loc.waitFor({ state: 'visible', timeout: 8_000 });
      await loc.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      await scrollSettled(page);
      await reveal(page, loc, 0.14);
      await scrollSettled(page);
      const box = await loc.boundingBox();
      if (box) { await glide(page, box.x + Math.min(box.width / 2, 120), box.y + box.height / 2); await sleep(200); }
      await assertPlacement(loc);
      break;
    }
    case 'scroll': {
      // [scroll 1200] or [scroll 1200 over 6] — the second form spreads the scroll over N seconds (a slow read-through).
      const m = a.arg.match(/^(-?\d+)(?:\s+over\s+([\d.]+))?/);
      const total = m ? parseInt(m[1], 10) : 400;
      const seconds = m && m[2] ? parseFloat(m[2]) : 0;
      const chunk = total > 0 ? 40 : -40;
      const ticks = Math.max(1, Math.round(Math.abs(total) / 40));
      const pause = seconds > 0 ? Math.max(8, Math.round((seconds * 1000) / ticks)) : 16;
      for (let i = 0; i < ticks; i++) { await page.mouse.wheel(0, chunk); await sleep(pause); }
      await sleep(seconds > 0 ? 200 : 400);
      break;
    }
    case 'type': await page.keyboard.type(a.arg, { delay: 55 }); await sleep(300); break;
    case 'press': await page.keyboard.press(a.arg); await sleep(400); break;
    case 'caret': {
      // [caret start] / [caret end] — move the caret in the focused text field (a click lands wherever the text is).
      const where = a.arg.trim() === 'end' ? 'end' : 'start';
      await page.evaluate((w) => {
        const el = document.activeElement as HTMLTextAreaElement | HTMLInputElement | null;
        if (el && typeof (el as any).setSelectionRange === 'function') {
          const pos = w === 'end' ? (el.value || '').length : 0;
          el.setSelectionRange(pos, pos);
          el.scrollTop = w === 'end' ? el.scrollHeight : 0;
        }
      }, where);
      await sleep(150);
      break;
    }
    case 'wait': await sleep(Math.round(parseFloat(a.arg) * 1000)); break;
    case 'upload': {
      // [upload <path>] — hands a file (path relative to the scene file's folder) to the page's open file chooser (<input type=file>).
      const file = path.isAbsolute(a.arg) ? a.arg : path.join(sceneDir, a.arg);
      await fs.access(file);
      await page.locator('input[type=file]').last().setInputFiles(file);
      await sleep(600);
      await settle(page);
      break;
    }
    case 'run': {
      // [run <shell command>] — runs from the scene file's folder and waits for it (staging data mid-scene).
      const { stdout, stderr } = await runShell(a.arg, 180_000, sceneDir);
      if (stderr.trim()) console.warn(`      run stderr: ${stderr.trim().split('\n').slice(-2).join(' / ')}`);
      console.log(`      run → ${stdout.trim().split('\n').slice(-1)[0] || '(no output)'}`);
      break;
    }
    case 'runbg': {
      // [runbg <shell command>] — starts it and moves on; the scene keeps talking while it works.
      runShell(a.arg, 600_000, sceneDir).then(({ stdout }) => console.log(`      runbg done → ${stdout.trim().split('\n').slice(-1)[0] || '(no output)'}`)).catch((e) => console.warn(`      runbg failed: ${e?.message || e}`));
      break;
    }
    default: throw new Error(`Unknown action [${a.kind}]`);
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`demo-recorder — narrated screen recordings of any web app from a scene file.

Usage:
  demo-recorder <scene.md> [--url https://your-app] [--audit]

  <scene.md>   Markdown scene: spoken text with [bracketed] actions (see HOW-TO-USE.md)
  --url        Base URL for [go /relative/path] targets (default: BASE_URL from .env)
  --audit      Dry run: no voice, no video — screenshots after every action

Examples:
  demo-recorder tour.scene.md --url http://localhost:5173 --audit
  demo-recorder tour.scene.md --url https://myapp.com

Docs: README.md, SETUP.md (install), HOW-TO-USE.md (scene format)`);
    return;
  }
  const audit = argv.includes('--audit');
  const urlFlagIdx = argv.indexOf('--url');
  const urlFlag = urlFlagIdx !== -1 ? argv[urlFlagIdx + 1] : undefined;
  const baseUrl = (urlFlag || env.BASE_URL || '').replace(/\/$/, '');
  const sceneFile = argv.filter((x, i) => !x.startsWith('--') && argv[i - 1] !== '--url')[0];
  if (!sceneFile) throw new Error('Usage: demo-recorder <scene.md> [--url https://your-app] [--audit]   (or: npm run record -- <scene.md> …)');
  const scenePath = path.resolve(sceneFile);
  const sceneDir = path.dirname(scenePath);
  const name = path.basename(scenePath).replace(/\.scene\.md$|\.md$/, '');
  const paragraphs = parseScene(await fs.readFile(scenePath, 'utf8'));
  const outDir = path.join(here, 'out'), cacheDir = path.join(here, 'cache'), workDir = path.join(outDir, `.${name}-work`);
  await fs.mkdir(outDir, { recursive: true }); await fs.mkdir(cacheDir, { recursive: true });
  await fs.rm(workDir, { recursive: true, force: true }); await fs.mkdir(workDir, { recursive: true });
  // Mirror the console into out/render.log so frames.sh can find the cursor moments afterwards.
  const logFile = path.join(outDir, 'render.log');
  const origLog = console.log.bind(console), origWarn = console.warn.bind(console);
  console.log = (...a: unknown[]) => { origLog(...a); fs.appendFile(logFile, a.join(' ') + '\n').catch(() => {}); };
  console.warn = (...a: unknown[]) => { origWarn(...a); fs.appendFile(logFile, a.join(' ') + '\n').catch(() => {}); };

  // 1. Narration first, so every action knows the moment it belongs to.
  console.log(`Scene "${name}": ${paragraphs.length} paragraphs, ${paragraphs.reduce((n, p) => n + p.anchors.reduce((m, a) => m + a.actions.length, 0), 0)} actions. Generating narration…`);
  const clips = new Map<number, Clip>();
  if (audit) {
    // Audit: no voice, no video — perform every action and screenshot after each one into out/audit/.
    await fs.rm(path.join(outDir, 'audit'), { recursive: true, force: true }); await fs.mkdir(path.join(outDir, 'audit'), { recursive: true });
  } else {
    for (const [i, p] of paragraphs.entries()) if (p.text) clips.set(i, await narrate(p.text, cacheDir));
  }
  console.log(`Narration ready: ${([...clips.values()].reduce((a, c) => a + c.ms, 0) / 1000).toFixed(0)}s of speech.`);

  // 2. Record.
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1, ...(audit ? {} : { recordVideo: { dir: workDir, size: { width: WIDTH, height: HEIGHT } } }), colorScheme: 'light' });
  await context.addInitScript(CURSOR_SCRIPT);
  const tCtx = Date.now(); // the recording's zero
  const page = await context.newPage();
  // Any failed request explains an audit (a 404 a wrong route, a 500 a broken step).
  page.on('response', (r) => {
    const method = r.request().method();
    // Failures always; in audit mode every write too, so a surprise state change can be traced to the call that made it.
    if (r.status() >= 400 || (audit && method !== 'GET' && method !== 'OPTIONS' && /^https?:/.test(r.url()))) console.warn(`      HTTP ${r.status()} ${method} ${r.url()}`);
  });
  const t0 = Date.now();
  if (baseUrl) {
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await settle(page);
  }
  await page.mouse.move(mouse.x, mouse.y);
  await sleep(800);

  const timeline: Array<{ at: number; file: string }> = [];
  // The video starts 400ms before the first word — never on the blank page the browser opened on.
  let trimMs = 0;
  const problems: string[] = [];
  let shot = 0;
  const act = async (a: Action) => {
    currentAction = a;
    try { await perform(page, a, baseUrl, sceneDir); }
    catch (err: any) { const msg = `line ${a.line} [${a.kind} ${a.arg}]: ${String(err?.message || err).split('\n')[0]}`; problems.push(msg); console.warn(`    ! ${msg}`); }
    if (audit) {
      shot++;
      const file = path.join(outDir, 'audit', `${String(shot).padStart(2, '0')}-L${a.line}-${a.kind}-${a.arg.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}.png`);
      await page.screenshot({ path: file, scale: 'css' });
    }
  };

  for (const [i, p] of paragraphs.entries()) {
    const clip = clips.get(i);
    const pre = p.anchors.filter((a) => a.offset === 0);
    const during = p.anchors.filter((a) => a.offset > 0);
    console.log(`  ¶ ${i + 1}/${paragraphs.length} @${((Date.now() - t0) / 1000).toFixed(1)}s  "${p.text.slice(0, 64)}${p.text.length > 64 ? '…' : ''}"`);
    // Actions before the first word run first; the voice starts once the screen is ready.
    for (const a of pre) for (const x of a.actions) await act(x);
    if (!clip) {
      if (audit) {
        // No voice in an audit, but the scene's timing still matters (background work started earlier):
        // hold roughly as long as the words would take, firing each anchor at its estimated moment.
        const wordsPerSecond = 2.6;
        const estimate = (offset: number) => Math.round((p.text.slice(0, offset).split(/\s+/).filter(Boolean).length / wordsPerSecond) * 1000);
        const begin = Date.now();
        for (const a of during) { const due = begin + estimate(a.offset); const wait = due - Date.now(); if (wait > 0) await sleep(wait); for (const x of a.actions) await act(x); }
        const total = begin + estimate(p.text.length) - Date.now();
        if (total > 0) await sleep(Math.min(total, 60_000));
      }
      continue;
    }
    const start = Date.now();
    if (!timeline.length) trimMs = Math.max(0, start - tCtx - 400);
    timeline.push({ at: start - tCtx, file: clip.file });
    console.log(`      ♪ @${((start - t0) / 1000).toFixed(1)}s voice starts`);
    for (const a of during) {
      const due = start + timeAt(clip, a.offset);
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait); else if (wait < -1000) console.warn(`    ~ running ${(-wait / 1000).toFixed(1)}s late: "${p.text.slice(a.offset, a.offset + 40)}"`);
      console.log(`      @${((Date.now() - t0) / 1000).toFixed(1)}s ${a.actions.map((x) => `[${x.kind} ${x.arg}]`).join(' ')}  ← "${p.text.slice(a.offset, a.offset + 36)}…"`);
      for (const x of a.actions) await act(x);
    }
    const remaining = clip.ms + TAIL_MS - (Date.now() - start);
    if (remaining > 0) await sleep(remaining);
  }
  await sleep(audit ? 200 : 1500);
  if (audit) {
    await context.close(); await browser.close();
    console.log(`Audit done: ${shot} screenshots in ${path.join(outDir, 'audit')}`);
    if (placement.length) console.warn(`\n${placement.length} placement problem(s) — the viewer would not see what the voice is talking about:\n  - ${placement.join('\n  - ')}`);
    if (problems.length) console.warn(`\n${problems.length} action(s) failed:\n  - ${problems.join('\n  - ')}`);
    if (problems.length || placement.length) process.exit(2);
    return;
  }
  const videoPath = await page.video()!.path();
  await context.close();
  await browser.close();

  // 3. Mux: every clip placed at the moment its paragraph started.
  const inputs: string[] = ['-ss', (trimMs / 1000).toFixed(3), '-i', videoPath];
  const filters: string[] = [];
  timeline.forEach((c, i) => { const at = Math.max(0, c.at - trimMs); inputs.push('-i', c.file); filters.push(`[${i + 1}:a]adelay=${at}|${at}[a${i}]`); });
  const mix = timeline.length ? `${filters.join(';')};${timeline.map((_, i) => `[a${i}]`).join('')}amix=inputs=${timeline.length}:normalize=0:dropout_transition=0[aout]` : '';
  const out = path.join(outDir, `${name}.mp4`);
  const args = [...inputs, ...(mix ? ['-filter_complex', mix, '-map', '0:v', '-map', '[aout]'] : ['-map', '0:v']), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', ...(mix ? ['-c:a', 'aac', '-b:a', '160k'] : []), '-movflags', '+faststart', '-y', out];
  console.log(`Encoding… (trim ${(trimMs / 1000).toFixed(1)}s of lead-in)`);
  await run(ffmpegPath as string, args, { maxBuffer: 64 * 1024 * 1024 });
  await fs.rm(workDir, { recursive: true, force: true });
  const { stdout } = await run(ffprobeStatic.path, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out]);
  console.log(`Done: ${out} (${Math.round(parseFloat(stdout))}s)`);
  if (placement.length) console.warn(`\n${placement.length} placement problem(s) — the viewer would not see what the voice is talking about:\n  - ${placement.join('\n  - ')}`);
  if (problems.length) console.warn(`\n${problems.length} action(s) failed:\n  - ${problems.join('\n  - ')}`);
  if (problems.length || placement.length) {
    console.warn('The video was rendered but is NOT fit to send — fix the scene and render again.');
    process.exit(2);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
