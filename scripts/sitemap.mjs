#!/usr/bin/env node
// Site map crawler (platform-owned, pushed next to browser.mjs).
//
//   node /workspace/scripts/sitemap.mjs <baseUrl> [--out <dir>] [--max <pages>] [--depth <n>]
//
// Walks the project's own site from <baseUrl>: follows same-origin links
// breadth-first, up to --max pages and --depth clicks from the start,
// screenshots each page (viewport, 1280x800) into <out>/<slug>.png and
// writes <out>/sitemap.json describing pages and the links between them.
// The same JSON is printed on stdout as one line prefixed "SITEMAP: " so the
// platform can read it without touching the file.
//
// Uses the platform's pinned Playwright (/opt/uttra-browser) - see
// browser.mjs for the same lookup and the version-mismatch fallback.
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const baseArg = argv.find((a) => !a.startsWith('--'));
if (!baseArg) {
  console.error('usage: sitemap.mjs <baseUrl> [--out dir] [--max n] [--depth n]');
  process.exit(2);
}
let base;
try {
  base = new URL(baseArg);
} catch {
  console.error(`not a valid URL: ${baseArg}`);
  process.exit(2);
}
const OUT = flag('out', '/workspace/.browser/sitemap');
const MAX_PAGES = Math.max(1, Math.min(40, Number(flag('max', 14)) || 14));
const MAX_DEPTH = Math.max(0, Math.min(4, Number(flag('depth', 2)) || 2));
const PAGE_TIMEOUT = 15_000;
const TOTAL_BUDGET = Number(flag('budget', 110_000)) || 110_000;
const VIEWPORT = { width: 1280, height: 800 };

async function loadChromium() {
  try {
    const req = createRequire('/opt/uttra-browser/package.json');
    const mod = req('playwright');
    const chromium = mod.chromium || mod.default?.chromium;
    if (chromium) return chromium;
  } catch {}
  try {
    return (await import('playwright')).chromium;
  } catch {}
  let entries = [];
  try {
    entries = await readdir('/workspace', { withFileTypes: true });
  } catch {}
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!existsSync(`/workspace/${e.name}/node_modules/playwright/package.json`)) continue;
    try {
      const req = createRequire(`/workspace/${e.name}/package.json`);
      const mod = req('playwright');
      return mod.chromium || mod.default?.chromium;
    } catch {}
  }
  return null;
}

async function findInstalledChromium() {
  const cache = '/root/.cache/ms-playwright';
  let entries = [];
  try {
    entries = await readdir(cache, { withFileTypes: true });
  } catch {
    return null;
  }
  const kinds = [
    { prefix: 'chromium_headless_shell-', sub: 'chrome-headless-shell-linux64/chrome-headless-shell' },
    { prefix: 'chromium-', sub: 'chrome-linux64/chrome' },
  ];
  for (const kind of kinds) {
    const builds = entries.filter((e) => e.isDirectory() && e.name.startsWith(kind.prefix)).map((e) => e.name).sort().reverse();
    for (const build of builds) {
      const exe = `${cache}/${build}/${kind.sub}`;
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

// normalizePath: same-origin links only, no hash/query, trailing slash
// trimmed, so "/about", "/about/" and "/about#team" are one page.
function normalizePath(href, from) {
  let u;
  try {
    u = new URL(href, from);
  } catch {
    return null;
  }
  if (u.origin !== base.origin) return null;
  if (!/^https?:$/.test(u.protocol)) return null;
  let p = u.pathname.replace(/\/+$/, '') || '/';
  // Files and API-looking paths are not pages.
  if (/\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|map|json|xml|txt|pdf|zip|mp4|mp3|woff2?|ttf)$/i.test(p)) return null;
  if (/^\/(api|_next|static|assets|__|@)/.test(p)) return null;
  return p;
}

// screenPath is the page's identity: "/login.html" and "/login" are the
// same screen (the platform maps edited files to routes the same way, see
// prompt/screen_work.go), "/index.html" is the home page.
function screenPath(p) {
  let s = p.replace(/\/index\.html?$/i, '/').replace(/\.html?$/i, '');
  s = s.replace(/\/+$/, '') || '/';
  return s;
}

const slugOf = (p) => (p === '/' ? 'home' : p.replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/-+$/, '').slice(0, 40) || 'page') + '-' + createHash('sha1').update(p).digest('hex').slice(0, 6);

const chromium = await loadChromium();
if (!chromium) {
  console.error('playwright is not installed');
  process.exit(4);
}
await mkdir(OUT, { recursive: true });
let browser;
const launchOpts = { headless: true };
try {
  browser = await chromium.launch(launchOpts);
} catch (err) {
  const exe = /Executable doesn't exist/.test(String(err && err.message)) ? await findInstalledChromium() : null;
  if (!exe) throw err;
  browser = await chromium.launch({ ...launchOpts, executablePath: exe });
}
const context = await browser.newContext({ viewport: VIEWPORT });
const page = await context.newPage();

const started = Date.now();
const queue = [{ path: '/', depth: 0 }];
const seen = new Set(['/']); // screen paths
const pages = [];
try {
  while (queue.length && pages.length < MAX_PAGES && Date.now() - started < TOTAL_BUDGET) {
    const { path, depth } = queue.shift();
    const url = base.origin + path;
    const entry = { path: screenPath(path), url: path, title: '', file: '', links: [], status: 0, depth };
    try {
      const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT }).catch(() => page.goto(url, { waitUntil: 'load', timeout: PAGE_TIMEOUT }));
      entry.status = resp ? resp.status() : 0;
      const type = resp ? (resp.headers()['content-type'] || '') : '';
      if (resp && !/text\/html/i.test(type) && type) {
        continue; // an API or a file, not a page
      }
      await page.waitForTimeout(600); // client-side hydration / router
      // The path the app actually landed on (a redirect to /login etc.).
      const landedUrl = normalizePath(page.url(), url) || path;
      const landed = screenPath(landedUrl);
      if (landed !== screenPath(path) && seen.has(landed)) {
        continue;
      }
      entry.url = landedUrl;
      entry.path = landed;
      seen.add(landed);
      entry.title = ((await page.title()) || '').trim().slice(0, 80);
      const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href') || ''));
      const links = [];
      for (const h of hrefs) {
        const raw = normalizePath(h, url);
        if (!raw) continue;
        const p = screenPath(raw);
        if (p === entry.path || links.some((l) => l.path === p)) continue;
        links.push({ path: p, url: raw });
      }
      entry.links = links.slice(0, 40).map((l) => l.path);
      entry.linkUrls = links.slice(0, 40).map((l) => l.url);
      const file = slugOf(entry.path) + '.png';
      await page.screenshot({ path: `${OUT}/${file}`, fullPage: false });
      entry.file = file;
      if (depth < MAX_DEPTH) {
        for (const l of links) {
          if (!seen.has(l.path) && seen.size < MAX_PAGES * 3) {
            seen.add(l.path);
            queue.push({ path: l.url, depth: depth + 1 });
          }
        }
      }
    } catch (err) {
      entry.error = String(err && err.message ? err.message : err).slice(0, 200);
    }
    pages.push(entry);
  }
} finally {
  await browser.close().catch(() => {});
}

// Links only to pages we actually captured keep the map honest; the rest
// are reported as "more" so the UI can say the site goes further.
const captured = new Set(pages.filter((p) => p.file).map((p) => p.path));
for (const p of pages) {
  p.more = p.links.filter((l) => !captured.has(l)).length;
  p.links = p.links.filter((l) => captured.has(l));
  delete p.linkUrls;
}
const result = {
  root: base.origin,
  generatedAt: Date.now(),
  truncated: queue.length > 0,
  pages: pages.filter((p) => p.file),
};
await writeFile(`${OUT}/sitemap.json`, JSON.stringify(result));
process.stdout.write('SITEMAP: ' + JSON.stringify(result) + '\n');
