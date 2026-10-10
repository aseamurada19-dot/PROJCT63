// /workspace/scripts/browser.mjs — generic authenticated-browser CLI for
// every project. Reads /workspace/.agents/browser-auth.json to figure
// out which cookies to attach, then drives Playwright.
//
// USAGE
//   node /workspace/scripts/browser.mjs screenshot <url> [--out <path>] [--full]
//   node /workspace/scripts/browser.mjs record     <url> [--duration <ms>] [--out <path>]
//   node /workspace/scripts/browser.mjs run        <recipe.mjs> [--record] [--out <path>] [--timeout <ms>]
//   node /workspace/scripts/browser.mjs connect    [recipe.mjs] [--timeout <ms>]
//
//   --out         override the output file path (default /workspace/.browser/<ts>.<ext>)
//   --full        full-page screenshot (default: viewport only)
//   --duration    record duration in ms (default 5000)
//   --record      (run) record a video of the recipe execution
//   --timeout     (run) abort the recipe after this many ms (default 300000)
//
// SCREENSHOT DIAGNOSTICS
//   `screenshot` prints the file path on stdout, and - only when there's
//   something wrong - a second line: `DIAGNOSTICS: {"httpStatus":...,
//   "consoleErrors":[...],"pageErrors":[...],"failedRequests":[...]}`. A
//   successful-looking screenshot is not proof the page actually rendered -
//   a blank white page from a JS error still returns 200 and screenshots
//   fine. Always check for this line before reporting a build as working.
//
// CONFIG (/workspace/.agents/browser-auth.json)
//   {
//     "<request-host>": {
//       "cookies": [
//         { "name": "<cookie-name>", "domain": "<cookie-domain>", "secret": "<ENV_VAR>",
//           "path": "/", "httpOnly": true, "secure": true, "sameSite": "None" }
//       ],
//       "basicAuth": "<ENV_VAR>"   // optional; env value is "user:pass".
//                                  // For sites behind HTTP Basic auth (e.g. a
//                                  // pre-launch gate). Applied via Playwright
//                                  // httpCredentials.
//     }
//   }
//
// Match rules for "<request-host>":
//   - exact host match (e.g. "app.graphixy.ai")
//   - wildcard "*.example.com" matches any sub.example.com
//   - "default" matches anything not otherwise listed (skip if you don't want
//     fallback)
//
// MISSING-COOKIE BEHAVIOUR
//   For screenshot/record:
//     - URL host has an entry, AND its named secret is set  → cookies attached.
//     - URL host has an entry, AND its named secret is unset → fail loud
//       (we don't silently take a logged-out shot of an app the user
//       expected us to be authenticated to). The error tells the agent
//       which secret to ask the user for.
//     - URL host has NO entry → assume public, proceed with no cookies.
//       Stdout prints the screenshot/video path normally.
//
//   For run: every cookie from every entry whose secret IS set gets
//   attached up-front, so recipes that visit multiple sites just work.
//   Entries whose secret env var is unset are silently skipped — if the
//   recipe hits a logged-out page that's a recipe-level concern.
//
// RECIPE SHAPE (for `run`)
//   // /workspace/.browser/recipes/<name>.mjs
//   export default async function (page, context) {
//     await page.goto('https://app.example.com/dashboard');
//     await page.click('text=Reports');
//     await page.waitForTimeout(1500);
//     // ...
//   };
//
//   The recipe gets a clean Playwright `page` and `context` with cookies
//   already attached. Anything it returns is printed as JSON; thrown
//   errors abort the run but the video (if any) is still flushed.
//
// OUTPUT — written to /workspace/.browser/ (override with $BROWSER_OUT_DIR).
//   Output path is printed on stdout so callers can `Read` the file.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CONFIG_PATH = process.env.BROWSER_AUTH_CONFIG || '/workspace/.agents/browser-auth.json';
const OUT_DIR = process.env.BROWSER_OUT_DIR || '/workspace/.browser';
const VIEWPORT = (() => {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(process.env.BROWSER_VIEWPORT || '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1280, height: 720 };
})();

function die(code, msg) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

function usage() {
  die(2, [
    'usage:',
    '  node /workspace/scripts/browser.mjs check      <url> [--expect "text"]...   (findings as text, no picture - one turn)',
    '  node /workspace/scripts/browser.mjs screenshot <url> [--out <path>] [--full] [--light] [--selector <css>]',
    '  node /workspace/scripts/browser.mjs record     <url> [--duration <ms>] [--out <path>]',
    '  node /workspace/scripts/browser.mjs run        <recipe.mjs> [--record] [--out <path>] [--timeout <ms>]',
    '  node /workspace/scripts/browser.mjs connect    [recipe.mjs] [--timeout <ms>]',
    '',
    `config: ${CONFIG_PATH}`,
    `output: ${OUT_DIR} (override with $BROWSER_OUT_DIR)`,
  ].join('\n'));
}

const args = process.argv.slice(2);
const [cmd, posArg, ...rest] = args;
if (!cmd) usage();
if (!['screenshot', 'check', 'record', 'run', 'connect', 'capture'].includes(cmd)) usage();
// connect's recipe arg is optional (no recipe = report open tabs); the
// other commands all require their positional arg.
if (cmd !== 'connect' && !posArg) usage();

let url;
if (cmd === 'screenshot' || cmd === 'check' || cmd === 'record') {
  try {
    url = new URL(posArg);
  } catch {
    die(2, `not a valid URL: ${posArg}`);
  }
}

// --- Load Playwright -----------------------------------------------------
// Playwright may live in any of:
//   - /workspace/node_modules/playwright            (workspace-level install)
//   - /workspace/<project>/node_modules/playwright  (project-level install,
//     common when the project itself uses Playwright for E2E)
//   - global node_modules                            (cli-installed)
//
// We try direct ESM import first (works when cwd's node_modules has it or
// it's globally installed); on failure, walk /workspace/*/ and use
// createRequire to leverage Node's full CJS resolution + package.json
// "main"/"exports" handling (the package's ESM entry exposes `chromium`
// directly; the CJS entry exposes it via `.default.chromium`).
async function loadChromium() {
  // Platform-owned install first (see agent-browser-install.sh): pinned to
  // the exact version whose browser binaries are baked into the container
  // image, so it can never hit a module/browser build mismatch - unlike a
  // project's own playwright install, which may be any version.
  try {
    const requirePlatform = createRequire('/opt/uttra-browser/package.json');
    const mod = requirePlatform('playwright');
    const chromium = mod.chromium || mod.default?.chromium;
    if (chromium) return chromium;
  } catch {}
  try {
    return (await import('playwright')).chromium;
  } catch {}
  const { readdir } = await import('node:fs/promises');
  let entries = [];
  try {
    entries = await readdir('/workspace', { withFileTypes: true });
  } catch {}
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const pkgJson = `/workspace/${e.name}/node_modules/playwright/package.json`;
    if (!existsSync(pkgJson)) continue;
    try {
      const requireFrom = createRequire(`/workspace/${e.name}/package.json`);
      const mod = requireFrom('playwright');
      return mod.chromium || mod.default?.chromium;
    } catch {}
  }
  return null;
}

const chromium = await loadChromium();
if (!chromium) {
  die(4, [
    'playwright is not installed in this workspace.',
    '',
    'Either install at workspace level (recommended, available to every',
    'project script):',
    '  cd /workspace && npm init -y >/dev/null && npm install --save-dev playwright',
    '  npx playwright install chromium',
    '',
    'Or install inside one of your project subdirs and re-run; this script',
    'discovers /workspace/*/node_modules/playwright automatically.',
    '',
    'First install downloads ~200MB of Chromium; cached for subsequent runs.',
  ].join('\n'));
}

// --- connect: drive the live GUI browser the user logged into ------------
// Attaches to the persistent headed Chrome over CDP (the same session the
// user logged into through the noVNC view) and runs an agent recipe against
// it, or — with no recipe — reports the open tabs so the agent can see the
// session state. Unlike the headless commands it does NOT attach cookies
// from browser-auth.json: the live profile is already authenticated.
// Disconnecting leaves the browser running for the human.
//
// Write policy (v1): before any public or irreversible action (post, reply,
// DM, follow, purchase, settings change) the agent must confirm with the
// user first. The human can also watch and intervene through the noVNC view.
if (cmd === 'connect') {
  const cdpURL = process.env.BROWSER_CDP_URL || 'http://127.0.0.1:9222';
  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpURL);
  } catch {
    die(6, [
      `could not connect to the GUI browser at ${cdpURL}.`,
      '',
      'Ask the user to open the Browser pane (that starts the session) and,',
      'for authenticated sites, log in first; then retry.',
    ].join('\n'));
  }
  const context = browser.contexts()[0] || (await browser.newContext());
  let exitCode = 0;
  try {
    if (posArg) {
      const recipePath = resolve(posArg);
      if (!existsSync(recipePath)) die(2, `recipe not found: ${recipePath}`);
      let mod;
      try {
        mod = await import(pathToFileURL(recipePath).href);
      } catch (err) {
        die(9, `failed to load recipe ${recipePath}: ${err.message}`);
      }
      if (typeof mod.default !== 'function') {
        die(9, `recipe ${recipePath} must export a default async function (page, context)`);
      }
      const page = context.pages()[0] || (await context.newPage());
      const timeoutMs = parseInt(flag(rest, 'timeout') || '300000', 10);
      const result = await Promise.race([
        mod.default(page, context),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`recipe exceeded --timeout ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);
      if (result !== undefined) {
        try {
          process.stdout.write(JSON.stringify(result) + '\n');
        } catch {
          process.stdout.write(String(result) + '\n');
        }
      }
    } else {
      const tabs = [];
      for (const pg of context.pages()) {
        tabs.push({ url: pg.url(), title: await pg.title().catch(() => '') });
      }
      process.stdout.write(JSON.stringify({ cdp: cdpURL, tabs }) + '\n');
    }
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    if (err.stack) process.stderr.write(err.stack + '\n');
    exitCode = 1;
  } finally {
    await browser.close(); // disconnects CDP; leaves the GUI browser running
  }
  process.exit(exitCode);
}

// capture: export the locked co-browse session's authenticated state (cookies
// + localStorage) as a Playwright storageState JSON, so the fast path can
// reuse the login the human just completed. Connects over CDP to the running
// (locked) browser, dumps the state, writes it to the given path. The caller
// then encrypts + stores it and wipes the browser (gui-up.sh cobrowse-wipe).
if (cmd === 'capture') {
  const cdpURL = process.env.BROWSER_CDP_URL || 'http://127.0.0.1:9222';
  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpURL);
  } catch {
    die(6, `could not connect to the browser at ${cdpURL} to capture the session.`);
  }
  try {
    const context = browser.contexts()[0] || (await browser.newContext());
    const state = await context.storageState();
    const out = resolve(posArg);
    await writeFile(out, JSON.stringify(state));
    process.stdout.write(out + '\n');
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  } finally {
    await browser.close();
  }
  process.exit(0);
}

// --- Load + match config -------------------------------------------------
let config = {};
if (existsSync(CONFIG_PATH)) {
  try {
    config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch (err) {
    die(5, `failed to parse ${CONFIG_PATH}: ${err.message}`);
  }
} else {
  // Create an empty config so the agent has a file to add to.
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, '{}\n');
}

function pickEntry(host) {
  if (config[host]) return config[host];
  for (const key of Object.keys(config)) {
    if (key.startsWith('*.')) {
      const suffix = key.slice(1); // ".example.com"
      if (host.endsWith(suffix) && host !== suffix.slice(1)) return config[key];
    }
  }
  return config.default;
}

function cookieFromEntry(c, fallbackHost) {
  return {
    name: c.name,
    value: process.env[c.secret],
    domain: c.domain || fallbackHost,
    path: c.path || '/',
    httpOnly: c.httpOnly !== false,
    secure: c.secure !== false,
    sameSite: c.sameSite || 'None',
    ...(c.expires != null ? { expires: c.expires } : {}),
  };
}

// HTTP Basic auth: an entry may carry `"basicAuth": "<ENV_VAR>"` whose value
// is "user:pass". Used for pre-launch sites behind a Cloudflare/edge gate.
// Playwright applies this at the context level via httpCredentials.
function basicAuthFromEntry(entry, origin) {
  if (!entry?.basicAuth) return undefined;
  const raw = process.env[entry.basicAuth];
  if (!raw) return undefined;
  const i = raw.indexOf(':');
  if (i < 0) return undefined;
  return { username: raw.slice(0, i), password: raw.slice(i + 1), origin };
}

let cookies = [];
let httpCredentials;
if (cmd === 'screenshot' || cmd === 'record') {
  // URL-driven: if this host has an entry, every cookie's secret must be
  // set (fail loud — agent should not silently take a logged-out shot of
  // an app that's supposed to be authenticated). If the host has no
  // entry, assume public and proceed with no cookies; the agent can tell
  // from the AUTH line in the output that nothing was attached.
  const entry = pickEntry(url.host);
  if (entry) {
    cookies = (entry.cookies || []).map((c) => {
      if (!c.secret) {
        die(7, `${CONFIG_PATH}: cookie for ${url.host} is missing "secret" (the env-var name holding the cookie value)`);
      }
      if (!process.env[c.secret]) {
        die(8, [
          `secret ${c.secret} is not set in the environment.`,
          '',
          `Ask the user to add it via the project Containers → Secrets UI.`,
          `Tell them which cookie to copy: ${c.name} from ${c.domain}.`,
        ].join('\n'));
      }
      return cookieFromEntry(c, url.host);
    });
    httpCredentials = basicAuthFromEntry(entry, url.origin);
  }
  // No entry → public site / not-configured-yet; proceed with cookies = [].

  // --cookie name=value attaches one literal cookie for the target host -
  // used by the platform's own automated preview verification to carry its
  // short-lived preview-check token through the dev-preview auth gate (see
  // browser.Adapter.Verify). Deliberately value-in-argv: the token is
  // host-bound and expires in minutes, and the only party able to read
  // this container's argv is the project itself, whose own preview it
  // unlocks - nothing new to leak.
  const literalCookie = flag(rest, 'cookie');
  if (literalCookie) {
    const eq = literalCookie.indexOf('=');
    if (eq > 0) {
      cookies.push({
        name: literalCookie.slice(0, eq),
        value: literalCookie.slice(eq + 1),
        domain: url.hostname,
        path: '/',
        secure: url.protocol === 'https:',
        httpOnly: false,
        sameSite: 'Lax',
      });
    }
  }
} else if (cmd === 'run') {
  // Recipe-driven: we don't know up-front which sites the recipe will
  // visit, so attach every cookie whose secret is set. Skip the rest
  // silently — if the recipe needs them, it'll hit a logged-out page and
  // can surface its own error.
  for (const host of Object.keys(config)) {
    const entry = config[host];
    if (entry?.cookies) {
      for (const c of entry.cookies) {
        if (!c.secret || !process.env[c.secret]) continue;
        cookies.push(cookieFromEntry(c, host.startsWith('*.') ? host.slice(2) : host));
      }
    }
    // First entry with a usable basicAuth wins (context-level, no origin so it
    // satisfies whichever gated host the recipe visits).
    if (!httpCredentials && entry?.basicAuth && process.env[entry.basicAuth]) {
      httpCredentials = basicAuthFromEntry(entry, undefined);
    }
  }
}

// --- Launch + drive Playwright ------------------------------------------
await mkdir(OUT_DIR, { recursive: true });

const recordingEnabled = cmd === 'record' || (cmd === 'run' && hasFlag(rest, 'record'));

const launchOpts = { headless: true };
const contextOpts = { viewport: VIEWPORT };
if (recordingEnabled) {
  contextOpts.recordVideo = { dir: OUT_DIR, size: VIEWPORT };
}
if (httpCredentials) {
  contextOpts.httpCredentials = httpCredentials;
}

// For `run`, resolve the recipe up-front so we fail fast on bad path
// before launching Chromium.
let recipeModule;
if (cmd === 'run') {
  const recipePath = resolve(posArg);
  if (!existsSync(recipePath)) die(2, `recipe not found: ${recipePath}`);
  try {
    recipeModule = await import(pathToFileURL(recipePath).href);
  } catch (err) {
    die(9, `failed to load recipe ${recipePath}: ${err.message}`);
  }
  if (typeof recipeModule.default !== 'function') {
    die(9, `recipe ${recipePath} must export a default async function (page, context)`);
  }
}

// --- Launch, tolerating a module/browser version mismatch ----------------
// The playwright *module* this script loaded may come from the project's own
// node_modules at whatever version the project happened to install, while
// the *browser binaries* baked into the container image are pinned by the
// platform (see agent-browser-install.sh / PLAYWRIGHT_VERSION). A newer
// module demands a browser build number the image doesn't have and dies with
// "Executable doesn't exist" even though a perfectly capable Chromium is
// sitting right there - the exact failure that silently broke automatic
// preview verification in production (2026-08-27). On that failure, find
// whatever Chromium build IS installed and point the module at it.
async function findInstalledChromium(headless) {
  const { readdir } = await import('node:fs/promises');
  const cache = '/root/.cache/ms-playwright';
  let entries = [];
  try {
    entries = await readdir(cache, { withFileTypes: true });
  } catch {
    return null;
  }
  // Prefer the headless shell for headless work, full Chromium otherwise -
  // and the newest build present of whichever kind matches.
  const kinds = headless
    ? [
        { prefix: 'chromium_headless_shell-', sub: 'chrome-headless-shell-linux64/chrome-headless-shell' },
        { prefix: 'chromium-', sub: 'chrome-linux64/chrome' },
      ]
    : [{ prefix: 'chromium-', sub: 'chrome-linux64/chrome' }];
  for (const kind of kinds) {
    // Note "chromium_headless_shell-" does not match the "chromium-" prefix
    // (underscore vs dash), so the two kinds never bleed into each other.
    const builds = entries
      .filter((e) => e.isDirectory() && e.name.startsWith(kind.prefix))
      .map((e) => e.name)
      .sort()
      .reverse();
    for (const build of builds) {
      const exe = `${cache}/${build}/${kind.sub}`;
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

// UTTRA_BROWSER_CDP_ENGINE (the platform's browser trial, service/trials):
// drive another engine that speaks the DevTools protocol - Obscura - through
// the very same checks instead of launching Chromium, so the two engines
// are compared on identical code. --measure prints what the run cost.
const cdpEngine = process.env.UTTRA_BROWSER_CDP_ENGINE || '';
const measure = hasFlag(rest, 'measure');
const measureStart = Date.now();
let browser;
if (cdpEngine) {
  // the engine was started just before this script: give it a moment to listen
  for (let i = 0; ; i++) {
    try {
      browser = await chromium.connectOverCDP(cdpEngine);
      break;
    } catch (err) {
      if (i >= 100) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
} else {
  try {
    browser = await chromium.launch(launchOpts);
  } catch (err) {
    const exe = /Executable doesn't exist/.test(String(err && err.message))
      ? await findInstalledChromium(launchOpts.headless !== false)
      : null;
    if (!exe) throw err;
    browser = await chromium.launch({ ...launchOpts, executablePath: exe });
  }
}

// peakBrowserKb: the browser's own memory high-water mark - every process
// whose command line is Chromium or Obscura, summed (node itself excluded).
async function peakBrowserKb() {
  const { readdir } = await import('node:fs/promises');
  let total = 0;
  for (const pid of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const cmd = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0/g, ' ');
      // the browser's own processes, not the shell or node that started them
      if (!/chrom|obscura/i.test(cmd) || /^(\S*\/)?(node|sh|bash|dash|timeout)\s/.test(cmd)) continue;
      const m = /VmHWM:\s+(\d+)/.exec(await readFile(`/proc/${pid}/status`, 'utf8'));
      if (m) total += Number(m[1]);
    } catch {}
  }
  return total;
}
// A session the user established in the shared (co-browse) browser - captured
// by the platform when they pressed Done (gui-up.sh cobrowse-capture) - is
// reused here automatically, so the headless fast path is signed in without
// asking the user to do it again. Explicit cookies from browser-auth.json are
// added on top and win on conflict.
const COBROWSE_STATE = '/workspace/.browser-gui/cobrowse-state.json';
if (existsSync(COBROWSE_STATE)) {
  try {
    const state = JSON.parse(await readFile(COBROWSE_STATE, 'utf8'));
    if (state && (Array.isArray(state.cookies) || Array.isArray(state.origins))) {
      contextOpts.storageState = state;
    }
  } catch {}
}
const context = await browser.newContext(contextOpts);
if (cookies.length) await context.addCookies(cookies);
const page = await context.newPage();

// Runtime failures a screenshot alone can't show: a blank page (a JS error
// during render), a rejected promise, or the page's own requests failing -
// exactly the class of bug this command exists to catch BEFORE a human ever
// opens the same URL. Collected for screenshot/record only (the two commands
// that load a single page and stop, as opposed to `run`'s multi-step
// recipes, which can reasonably expect transient console noise mid-flow).
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
if (cmd === 'screenshot' || cmd === 'check' || cmd === 'record') {
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // Chrome's "Failed to load resource: the server responded with a
    // status of 404 ()" names no URL in its text - the URL is only in the
    // message's location. Without it a missing favicon (benign, filtered
    // by URL downstream) is indistinguishable from a missing module and
    // costs the user a whole "fix" turn (prod, 2026-08-31).
    let at = '';
    try {
      const loc = msg.location?.();
      if (loc && loc.url) at = ` (${loc.url})`;
    } catch {}
    consoleErrors.push(msg.text() + at);
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('requestfailed', (req) => {
    failedRequests.push(`${req.method()} ${req.url()} - ${req.failure()?.errorText ?? 'failed'}`);
  });
}

let exitCode = 0;
let recordOverride;
try {
  if (cmd === 'screenshot') {
    // Heavy sites (ad/analytics beacons, long-polling chat widgets) never
    // reach networkidle: fall back to 'load' so the agent still gets a
    // picture instead of a timeout - copying a reference site died on
    // exactly this (prod, 2026-09-10).
    let response;
    if (hasFlag(rest, 'fast')) {
      // --fast (the platform's own check): 'load' then up to 6 s of quiet
      // network instead of a 30 s networkidle wait - a page with a
      // beacon or a long poll used to cost the whole timeout.
      response = await page.goto(url.toString(), { waitUntil: 'load', timeout: 20_000 });
      await Promise.race([page.waitForLoadState('networkidle').catch(() => {}), page.waitForTimeout(6000)]);
      await page.waitForTimeout(300);
    } else {
      try {
        response = await page.goto(url.toString(), { waitUntil: 'networkidle', timeout: 30_000 });
      } catch (err) {
        if (!/Timeout/i.test(String(err && err.message))) throw err;
        response = await page.goto(url.toString(), { waitUntil: 'load', timeout: 45_000 });
        await page.waitForTimeout(2500);
      }
    }
    const out = resolve(flag(rest, 'out') || `${OUT_DIR}/screenshot-${ts()}.png`);
    await mkdir(dirname(out), { recursive: true });
    // the trial compares the checks, not pictures: an engine driven over
    // CDP may not render at all
    if (!cdpEngine) {
    if (hasFlag(rest, 'full')) {
      // A full-page capture must show what a person who scrolled would
      // see: walk the page so scroll-triggered reveals and lazy images
      // fire, then return to the top before capturing.
      try {
        await page.evaluate(async () => {
          const step = Math.max(400, window.innerHeight * 0.8);
          for (let y = 0; y < document.body.scrollHeight; y += step) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 90));
          }
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(500);
      } catch {}
    }
    // --light: a 900px-wide JPEG - a third of the image tokens of the
    // default PNG, enough to judge a layout; --selector: only that element.
    const light = hasFlag(rest, 'light');
    const selector = flag(rest, 'selector');
    const shotOpts = { path: light ? out.replace(/\.png$/i, '.jpg') : out, fullPage: hasFlag(rest, 'full') && !selector };
    if (light) { shotOpts.type = 'jpeg'; shotOpts.quality = 55; if (!selector) await page.setViewportSize({ width: 900, height: Math.round((900 * VIEWPORT.height) / VIEWPORT.width) }); }
    if (selector) { const el = await page.$(selector); if (!el) die(1, `no element matches --selector ${selector}`); await el.screenshot(shotOpts); }
    else await page.screenshot(shotOpts);
    if (light) process.stdout.write(shotOpts.path + '\n');
    if (!light) process.stdout.write(out + '\n');
    }
    // Only printed when there's something to report - a clean page's output
    // stays exactly the bare path it always was. The agent must not treat a
    // 200 response and a screenshot file as proof the page actually
    // rendered: this is the same class of bug as a blank white page, which
    // returns 200 and screenshots "successfully" while showing nothing.
    const httpStatus = response?.status();
    // A blank page (an empty mounted root, a silently-swallowed render
    // error) returns 200 and screenshots "successfully" with nothing on it -
    // console/page-error checks above don't catch this class at all. A real
    // page almost always has SOME text within a couple hundred ms of
    // network-idle (a heading, a label, an error message); under ~20 chars
    // on a successful response is the signature of an empty mount.
    let bodyTextLength = 0;
    let likelyBlank = false;
    // The preview must show the SITE - what the project's own users see -
    // never an API/backend answer. A backend on the preview port looks
    // like: a non-HTML content type (JSON, plain text), a body that is a
    // JSON document, or Express's "Cannot GET /". Reported so the platform
    // can move the preview to the port that serves the actual frontend.
    const contentType = String(response?.headers?.()?.['content-type'] ?? '');
    let bodySample = '';
    let looksLikeBackend = false;
    if (httpStatus != null && httpStatus < 400) {
      try {
        // The platform's own watermark badge ("Built with Uttra.dev", 20
        // chars - exactly the old threshold) is not the page's content:
        // measured without it, a blank app is blank. An app root that
        // exists and is empty is blank too, whatever the text length says
        // (prod, 2026-08-31: a white page passed as "not blank" because of
        // the badge text).
        const measured = await page.evaluate(() => {
          const badge = document.getElementById('__uttra-watermark');
          const badgeText = badge ? (badge.innerText || '').trim() : '';
          let text = (document.body?.innerText ?? '').trim();
          if (badgeText && text.endsWith(badgeText)) text = text.slice(0, text.length - badgeText.length).trim();
          const root = document.getElementById('root') || document.getElementById('app');
          return { length: text.length, sample: text.slice(0, 160), rootEmpty: !!root && root.childElementCount === 0 };
        });
        bodyTextLength = measured.length;
        bodySample = measured.sample;
        likelyBlank = bodyTextLength < 20 || measured.rootEmpty;
        looksLikeBackend =
          (contentType !== '' && !/text\/html/i.test(contentType)) ||
          /^\s*[\[{]/.test(bodySample) ||
          /^Cannot (GET|POST|HEAD) \//.test(bodySample);
        if (looksLikeBackend) likelyBlank = false;
      } catch {
        // page.evaluate can fail if the page navigated away/closed mid-check
        // - not itself evidence of a blank page, leave likelyBlank false.
      }
    }
    if (measure || httpStatus >= 400 || consoleErrors.length || pageErrors.length || failedRequests.length || likelyBlank || looksLikeBackend) {
      process.stdout.write(
        'DIAGNOSTICS: ' +
          JSON.stringify({ httpStatus, consoleErrors, pageErrors, failedRequests, bodyTextLength, likelyBlank, contentType, bodySample, looksLikeBackend }) +
          '\n'
      );
    }
    if (measure) {
      process.stdout.write('MEASURE: ' + JSON.stringify({ ms: Date.now() - measureStart, peakKb: await peakBrowserKb() }) + '\n');
    }
  } else if (cmd === 'check') {
    // `check <url> [--expect "text"]...` - the page opened for real, the
    // findings as TEXT and no picture: a check is one model turn instead of
    // the two a screenshot costs (the command, then reading the image), and
    // no image tokens. Covers what a person would notice at a glance
    // without a picture: errors, a blank page, horizontal overflow,
    // overlapping controls, broken images, wrong text direction, unreadable
    // contrast, and whether expected text is on the page. A fingerprint of
    // the rendered page says when nothing changed since the last check.
    let response;
    try {
      response = await page.goto(url.toString(), { waitUntil: 'networkidle', timeout: 30_000 });
    } catch (err) {
      if (!/Timeout/i.test(String(err && err.message))) throw err;
      response = await page.goto(url.toString(), { waitUntil: 'load', timeout: 45_000 });
      await page.waitForTimeout(2500);
    }
    const httpStatus = response?.status();
    const contentType = String(response?.headers?.()?.['content-type'] ?? '');
    const expects = [];
    for (let i = 0; i < rest.length; i++) if (rest[i] === '--expect' && rest[i + 1]) expects.push(rest[++i]);
    const facts = await page.evaluate((expects) => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
      };
      const badge = document.getElementById('__uttra-watermark');
      const badgeText = badge ? (badge.innerText || '').trim() : '';
      let text = (document.body?.innerText ?? '').trim();
      if (badgeText && text.endsWith(badgeText)) text = text.slice(0, text.length - badgeText.length).trim();
      const root = document.getElementById('root') || document.getElementById('app');
      const overflow = document.documentElement.scrollWidth - window.innerWidth;
      // overlapping controls: interactive elements whose boxes intersect a lot
      const controls = [...document.querySelectorAll('button, a, input, select, textarea, [role=button]')].filter(vis).slice(0, 120);
      const overlaps = [];
      for (let i = 0; i < controls.length && overlaps.length < 4; i++) {
        const a = controls[i].getBoundingClientRect();
        for (let j = i + 1; j < controls.length; j++) {
          const b = controls[j].getBoundingClientRect();
          const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ix > 8 && iy > 8 && ix * iy > 0.4 * Math.min(a.width * a.height, b.width * b.height) && !controls[i].contains(controls[j]) && !controls[j].contains(controls[i])) {
            const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 30);
            overlaps.push(`"${label(controls[i])}" overlaps "${label(controls[j])}"`);
            break;
          }
        }
      }
      const brokenImages = [...document.images].filter((im) => im.complete && im.naturalWidth === 0 && im.getAttribute('src')).map((im) => im.getAttribute('src')).slice(0, 5);
      // direction: Arabic-heavy page should be RTL
      const arabic = (text.match(/[؀-ۿ]/g) || []).length;
      const letters = (text.match(/[A-Za-z؀-ۿ]/g) || []).length;
      const dir = (document.documentElement.getAttribute('dir') || getComputedStyle(document.body).direction || 'ltr').toLowerCase();
      const rtlMismatch = letters > 40 && arabic / letters > 0.6 && dir !== 'rtl';
      // contrast: sample text nodes against the nearest painted background
      const lum = (rgb) => {
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(rgb);
        if (!m) return null;
        if (m[4] !== undefined && Number(m[4]) === 0) return null;
        const f = (c) => { c = Number(c) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(m[1]) + 0.7152 * f(m[2]) + 0.0722 * f(m[3]);
      };
      const lowContrast = [];
      const textEls = [...document.querySelectorAll('h1,h2,h3,p,li,a,button,label,span,td,th')].filter(vis).filter((el) => (el.innerText || '').trim().length > 3).slice(0, 160);
      for (const el of textEls) {
        const fg = lum(getComputedStyle(el).color);
        // walk up to the painted background; text over an image or a
        // gradient cannot be judged from CSS alone - skip it rather than
        // report a hero heading as unreadable
        let node = el, bg = null, onImage = false;
        while (node && node !== document.documentElement && bg === null) {
          const cs = getComputedStyle(node);
          if (cs.backgroundImage && cs.backgroundImage !== 'none') { onImage = true; break; }
          bg = lum(cs.backgroundColor);
          node = node.parentElement;
        }
        if (onImage || fg === null) continue;
        if (bg === null) bg = lum(getComputedStyle(document.body).backgroundColor) ?? 1;
        const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        if (ratio < 3) { lowContrast.push(`"${(el.innerText || '').trim().slice(0, 28)}" (${ratio.toFixed(1)}:1)`); if (lowContrast.length >= 4) break; }
      }
      const missing = expects.filter((e) => !text.includes(e) && !document.body.innerHTML.includes(e));
      const h1 = (document.querySelector('h1')?.innerText || '').trim().slice(0, 80);
      const html = document.documentElement.outerHTML.replace(/<script[\s\S]*?<\/script>/g, '').replace(/\s+/g, ' ');
      let hash = 0;
      for (let i = 0; i < html.length; i++) hash = (hash * 31 + html.charCodeAt(i)) | 0;
      return { textLength: text.length, sample: text.slice(0, 120), rootEmpty: !!root && root.childElementCount === 0, overflow, overlaps, brokenImages, rtlMismatch, dir, lowContrast, missing, title: document.title, h1, fingerprint: (hash >>> 0).toString(16), viewport: window.innerWidth };
    }, expects);
    const issues = [];
    if (httpStatus == null || httpStatus >= 400) issues.push(`HTTP ${httpStatus ?? 'no response'}`);
    const looksLikeBackend = (contentType !== '' && !/text\/html/i.test(contentType)) || /^\s*[\[{]/.test(facts.sample) || /^Cannot (GET|POST|HEAD) \//.test(facts.sample);
    if (looksLikeBackend) issues.push(`this port answers like a backend/API (${contentType || 'no content-type'}), not the site`);
    else if (httpStatus < 400 && (facts.textLength < 20 || facts.rootEmpty)) issues.push(`blank page: ${facts.textLength} chars of text${facts.rootEmpty ? ', empty app root' : ''}`);
    for (const e of pageErrors) issues.push(`page error: ${e}`);
    for (const e of consoleErrors.filter((c) => !/favicon/i.test(c))) issues.push(`console error: ${e}`);
    for (const r of failedRequests.filter((f) => !/favicon/i.test(f))) issues.push(`failed request: ${r}`);
    if (facts.overflow > 4) issues.push(`horizontal overflow: page ${facts.viewport + facts.overflow}px wide in a ${facts.viewport}px viewport`);
    for (const o of facts.overlaps) issues.push(`overlapping controls: ${o}`);
    for (const b of facts.brokenImages) issues.push(`broken image: ${b}`);
    if (facts.rtlMismatch) issues.push(`Arabic content rendered ${facts.dir.toUpperCase()}: set dir="rtl" on <html>`);
    for (const c of facts.lowContrast) issues.push(`low contrast: ${c}`);
    for (const m of facts.missing) issues.push(`expected text not on the page: "${m}"`);
    // fingerprint memory: the same page unchanged since the last check
    const memPath = `${OUT_DIR}/checks.json`;
    let mem = {};
    try { mem = JSON.parse(await readFile(memPath, 'utf8')); } catch {}
    const key = url.toString();
    const prev = mem[key];
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
    mem[key] = { fingerprint: facts.fingerprint, at: now, issues: issues.length };
    try { await mkdir(OUT_DIR, { recursive: true }); await writeFile(memPath, JSON.stringify(mem)); } catch {}
    const lines = [];
    lines.push(`CHECK ${key} -> ${httpStatus ?? 'no response'} ${contentType.split(';')[0] || ''}, ${facts.textLength} chars${facts.title ? `, title "${facts.title.slice(0, 60)}"` : ''}${facts.h1 ? `, h1 "${facts.h1}"` : ''}`);
    if (issues.length === 0) lines.push('OK: no errors, no failed requests, not blank, no horizontal overflow, no overlapping controls, images load, direction and contrast fine' + (expects.length ? `, expected text present` : ''));
    else { lines.push(`ISSUES (${issues.length}):`); for (const i of issues.slice(0, 12)) lines.push(`- ${i}`); }
    if (prev && prev.fingerprint === facts.fingerprint) lines.push(`UNCHANGED since the check at ${prev.at} - the page renders the same; no need to look again.`);
    process.stdout.write(lines.join('\n') + '\n');
  } else if (cmd === 'record') {
    const duration = parseInt(flag(rest, 'duration') || '5000', 10);
    await page.goto(url.toString(), { timeout: 30_000 });
    await page.waitForTimeout(duration);
    recordOverride = flag(rest, 'out');
  } else if (cmd === 'run') {
    const timeoutMs = parseInt(flag(rest, 'timeout') || '300000', 10);
    recordOverride = flag(rest, 'out');
    const result = await Promise.race([
      recipeModule.default(page, context),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`recipe exceeded --timeout ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    if (result !== undefined) {
      // Recipes can return data (e.g. scraped text). Print as JSON so
      // callers can parse stdout. Video path (if any) prints separately
      // in the finally block.
      try {
        process.stdout.write(JSON.stringify(result) + '\n');
      } catch {
        process.stdout.write(String(result) + '\n');
      }
    }
  }
} catch (err) {
  process.stderr.write(`error: ${err.message}\n`);
  if (err.stack) process.stderr.write(err.stack + '\n');
  exitCode = 1;
} finally {
  const video = recordingEnabled ? page.video() : null;
  await page.close();
  await context.close();
  await browser.close();
  if (video) {
    const defaultPath = await video.path();
    if (recordOverride) {
      const target = resolve(recordOverride);
      await mkdir(dirname(target), { recursive: true });
      await rename(defaultPath, target);
      process.stdout.write(target + '\n');
    } else {
      process.stdout.write(defaultPath + '\n');
    }
  }
}

process.exit(exitCode);

function ts() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
