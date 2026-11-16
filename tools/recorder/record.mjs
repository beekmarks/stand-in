#!/usr/bin/env node
// stand-in: drive a simulated user through a page and record it with Chrome's native
// MP4 tab recorder (CDP Page.startScreenRecording, Chrome 153+) via the `chrome-capture` library.
//
//   node record.mjs inspect <url> [--out DIR] [--plan plan.json]   list interactive elements + screenshot
//   node record.mjs <plan.json> --rehearse [--out DIR]             run the plan without recording, screenshot each step
//   node record.mjs <plan.json> [--out DIR] [--output video.mp4]   record it
//
// Common flags: --chrome PATH, --headful.  Plan format: see ../../docs/plan-format.md

import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {homedir, platform} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';

const MIN_CHROME = 153;

// ------------------------------------------------------------------------------------------
// Dependencies: installed once into a cache dir, so the skill folder itself can stay read-only.
// ------------------------------------------------------------------------------------------
async function loadDeps() {
  // 1) Installed next to this script (`npm ci` in tools/recorder: pinned by package-lock.json).
  try {
    const local = createRequire(import.meta.url);
    const load = async name => import(pathToFileURL(local.resolve(name)).href);
    const [pw, cc] = await Promise.all([load('playwright-core'), load('chrome-capture')]);
    return {chromium: pw.chromium ?? pw.default.chromium, startRecording: cc.startRecording, findChromeBinary: cc.findChromeBinary};
  } catch {}
  // 2) Otherwise a per-user cache, installed on first run.
  const home = process.env.STAND_IN_HOME ?? join(homedir(), '.cache', 'stand-in');
  const pkgs = {'chrome-capture': '^0.1.2', 'playwright-core': '^1.63.0'};
  const have = Object.keys(pkgs).every(p => existsSync(join(home, 'node_modules', p, 'package.json')));
  if (!have) {
    log(`Installing ${Object.keys(pkgs).join(' + ')} into ${home} (one-time)…`);
    await mkdir(home, {recursive: true});
    if (!existsSync(join(home, 'package.json'))) await writeFile(join(home, 'package.json'), '{"private":true}\n');
    const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--prefix', home,
      ...Object.entries(pkgs).map(([n, v]) => `${n}@${v}`)], {stdio: 'inherit', shell: platform() === 'win32'});
    if (r.status !== 0) die('npm install failed. Check network access to registry.npmjs.org.');
  }
  const req = createRequire(join(home, 'package.json'));
  const load = async name => import(pathToFileURL(req.resolve(name)).href);
  const [pw, cc] = await Promise.all([load('playwright-core'), load('chrome-capture')]);
  return {chromium: pw.chromium ?? pw.default.chromium, startRecording: cc.startRecording, findChromeBinary: cc.findChromeBinary};
}

// ------------------------------------------------------------------------------------------
// Chrome discovery: needs M153+ (Page.startScreenRecording).
// ------------------------------------------------------------------------------------------
function chromeMajor(path) {
  const re = /^(\d+)\.\d+\.\d+\.\d+$/;
  if (platform() === 'win32') {
    // chrome.exe --version prints nothing on Windows. Installs keep a version-named folder next to the exe.
    try {
      const v = readdirSync(dirname(path)).map(d => re.exec(d)).filter(Boolean).map(m => +m[1]);
      if (v.length) return Math.max(...v);
    } catch {}
    const ps = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${path.replace(/'/g, "''")}').VersionInfo.ProductVersion`],
      {encoding: 'utf8', timeout: 15000});
    const m = /(\d+)\.\d+\.\d+\.\d+/.exec(ps.stdout ?? '');
    return m ? +m[1] : 0;
  }
  const r = spawnSync(path, ['--version'], {encoding: 'utf8', timeout: 15000});
  const m = /(\d+)\.\d+\.\d+\.\d+/.exec(r.stdout ?? '');
  return m ? +m[1] : 0;
}
function standardChromePaths() {
  if (platform() === 'darwin') {
    return ['Google Chrome Canary', 'Google Chrome Dev', 'Google Chrome Beta', 'Google Chrome']
      .map(n => `/Applications/${n}.app/Contents/MacOS/${n}`);
  }
  if (platform() === 'win32') {
    const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean);
    return roots.flatMap(r => ['Chrome SxS', 'Chrome Dev', 'Chrome Beta', 'Chrome'].map(c => join(r, 'Google', c, 'Application', 'chrome.exe')));
  }
  return ['/usr/bin/google-chrome-unstable', '/usr/bin/google-chrome-beta', '/usr/bin/google-chrome', '/usr/bin/chromium'];
}
async function findChrome(explicit, findChromeBinary) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  candidates.push(...standardChromePaths());
  try { candidates.push(await findChromeBinary()); } catch {}
  const pwDirs = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', join(homedir(), '.cache', 'ms-playwright'),
    join(homedir(), 'Library', 'Caches', 'ms-playwright'), process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright')].filter(Boolean);
  for (const dir of pwDirs) {
    let entries = [];
    try { entries = readdirSync(dir).filter(e => /^chromium-\d+$/.test(e)); } catch { continue; }
    for (const e of entries) {
      for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome',
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win64/chrome.exe']) {
        if (existsSync(join(dir, e, sub))) candidates.push(join(dir, e, sub));
      }
    }
  }
  const seen = new Set(), tried = [];
  for (const c of candidates) {
    if (!c || seen.has(c) || !existsSync(c)) continue;
    seen.add(c);
    const major = chromeMajor(c);
    tried.push(`${c} (M${major || '?'})`);
    if (major >= MIN_CHROME) return c;
    if (c === explicit) break;
  }
  die(`Need Chrome ${MIN_CHROME}+ for native tab recording. Checked:\n  ${tried.join('\n  ') || '(nothing found)'}\n` +
    `Install one (e.g. \`npx @puppeteer/browsers install chrome@beta\`) and pass --chrome PATH or set CHROME_PATH.`);
}

// ------------------------------------------------------------------------------------------
// In-page overlay: synthetic cursor (headless Chrome draws none), click ripple, captions, highlight.
// Lives in a closed-off shadow root at max z-index; re-installed on every navigation.
// ------------------------------------------------------------------------------------------
function overlayInit(opts) {
  if (window.__demoOverlay || window.__demoForwarder) return;
  // Pointer events over an <iframe> go to the iframe's document, not ours. Every frame forwards its pointer
  // events to its parent (which adds the iframe's offset) until they reach the top frame's cursor overlay.
  const MSG = '__stand_in_ptr';
  const relay = (type, x, y) => { try { parent.postMessage({[MSG]: 1, type, x, y}, '*'); } catch {} };
  const offsetOf = src => {
    for (const f of document.querySelectorAll('iframe,frame')) {
      if (f.contentWindow !== src) continue;
      const r = f.getBoundingClientRect(), cs = getComputedStyle(f), k = f.offsetWidth ? r.width / f.offsetWidth : 1;
      return [r.left + (f.clientLeft + parseFloat(cs.paddingLeft)) * k, r.top + (f.clientTop + parseFloat(cs.paddingTop)) * k, k];
    }
    return null;
  };
  if (window.top !== window) {
    window.__demoForwarder = true;
    for (const t of ['pointermove', 'pointerdown', 'pointerup']) addEventListener(t, e => relay(t, e.clientX, e.clientY), true);
    addEventListener('message', e => {
      const d = e.data; if (!d || !d[MSG]) return;
      const o = offsetOf(e.source); if (o) relay(d.type, o[0] + d.x * o[2], o[1] + d.y * o[2]);
    });
    return;
  }
  let root, cursor, caption, x = -100, y = -100, shown = false;
  const css = `
    :host { all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; }
    .cur { position: fixed; left: 0; top: 0; width: 28px; height: 28px; margin: -3px 0 0 -4px; opacity: 0;
      filter: drop-shadow(0 2px 3px rgba(0,0,0,.45)); transition: opacity .2s, scale .12s; transform-origin: 4px 3px; }
    .cur.on { opacity: 1; } .cur.down { scale: .86; }
    .rip { position: fixed; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%;
      border: 3px solid ${opts.accent}; animation: rip .55s ease-out forwards; }
    @keyframes rip { from { opacity: .95; transform: scale(.6); } to { opacity: 0; transform: scale(3.6); } }
    .cap { position: fixed; left: 50%; bottom: 6%; translate: -50% 0; max-width: 78%; padding: .55em 1.1em;
      border-radius: .6em; background: rgba(15,17,26,.88); color: #fff; text-align: center;
      font: 600 ${opts.captionSize}px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: .005em;
      box-shadow: 0 10px 30px rgba(0,0,0,.35); opacity: 0; transform: translateY(12px); transition: opacity .3s, transform .3s; }
    .cap.on { opacity: 1; transform: none; }
    .hl { position: fixed; border-radius: 10px; box-shadow: 0 0 0 4px ${opts.accent}, 0 0 0 9999px rgba(0,0,0,.28);
      opacity: 0; transition: opacity .3s; }
    .hl.on { opacity: 1; }
    .badge { position: fixed; left: 14px; bottom: 14px; padding: 7px 12px; border-radius: 999px; background: #b91c1c; color: #fff;
      font: 600 13px/1 system-ui, sans-serif; box-shadow: 0 4px 14px rgba(0,0,0,.3); }
    /* Keep-alive: Chrome's capturer only emits a frame when something repaints, so a static page gives a
       variable-frame-rate file. A 2px compositor animation at ~1% opacity forces a steady 60fps. */
    .ka { position: fixed; right: 0; bottom: 0; width: 2px; height: 2px; background: #808080;
      animation: ka 1s linear infinite alternate; }
    @keyframes ka { from { opacity: .01; } to { opacity: .02; } }`;
  function ensure() {
    if (root?.host.isConnected) return true;
    if (!document.documentElement) return false;
    const host = document.createElement('demo-overlay');
    root = host.attachShadow({mode: 'open'});
    root.innerHTML = `<style>${css}</style><div class="cap"></div>` + (opts.keepAlive ? '<div class="ka"></div>' : '') + (opts.cursor ?
      `<svg class="cur" viewBox="0 0 24 24"><path d="M3 2 L3 19.5 L7.9 15 L11.3 22.4 L14.6 20.9 L11.2 13.6 L18 13.6 Z"
        fill="${opts.cursorColor}" stroke="${opts.cursorStroke}" stroke-width="1.5" stroke-linejoin="round"/></svg>` : '');
    cursor = root.querySelector('.cur'); caption = root.querySelector('.cap');
    // Render in the top layer (as a manual popover) so modal <dialog>s and popovers can't cover the cursor.
    host.setAttribute('popover', 'manual');
    host.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;' +
      'padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483647';
    document.documentElement.append(host);
    raise();
    place();
    return true;
  }
  function raise() {
    const host = root?.host;
    if (!host?.isConnected || !host.showPopover) return;
    try { if (host.matches(':popover-open')) host.hidePopover(); host.showPopover(); } catch {}
  }
  // Something else entered the top layer (modal dialog, popover, fullscreen): re-raise above it.
  const reraise = e => { if (e?.target !== root?.host) queueMicrotask(raise); };
  addEventListener('toggle', reraise, true);
  addEventListener('fullscreenchange', reraise, true);
  new MutationObserver(muts => { if (muts.some(m => m.target.tagName === 'DIALOG')) raise(); })
    .observe(document, {subtree: true, attributes: true, attributeFilter: ['open']});
  function place() {
    if (!cursor) return;
    const z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    if (root?.host) root.host.style.zoom = String(1 / z);
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    cursor.classList.toggle('on', shown);
  }
  const onMove = (cx, cy) => { x = cx; y = cy; shown = true; ensure() && place(); };
  const onDown = (cx, cy) => {
    if (!ensure()) return;
    place();
    cursor?.classList.add('down');
    if (!opts.cursor) return;
    const r = document.createElement('div'); r.className = 'rip';
    r.style.left = cx + 'px'; r.style.top = cy + 'px';
    root.append(r); setTimeout(() => r.remove(), 650);
  };
  const onUp = () => cursor?.classList.remove('down');
  addEventListener('pointermove', e => onMove(e.clientX, e.clientY), true);
  addEventListener('pointerdown', e => onDown(e.clientX, e.clientY), true);
  addEventListener('pointerup', onUp, true);
  addEventListener('message', e => {
    const d = e.data; if (!d || !d[MSG]) return;
    const o = offsetOf(e.source); if (!o) return;
    const cx = o[0] + d.x * o[2], cy = o[1] + d.y * o[2];
    if (d.type === 'pointermove') onMove(cx, cy); else if (d.type === 'pointerdown') onDown(cx, cy); else onUp();
  });
  // Keep the overlay alive if a SPA wipes <html> children.
  new MutationObserver(() => { if (root && !root.host.isConnected) { root = null; ensure(); } })
    .observe(document, {childList: true, subtree: false});
  document.addEventListener('DOMContentLoaded', ensure);
  window.__demoOverlay = {
    badge(text) {
      if (!ensure()) return;
      let b = root.querySelector('.badge');
      if (!b) { b = document.createElement('div'); b.className = 'badge'; root.append(b); }
      b.textContent = text;
    },
    caption(text) {
      if (!ensure()) return;
      if (text) { caption.textContent = text; caption.classList.add('on'); } else caption.classList.remove('on');
    },
    highlight(rect, ms) {
      if (!ensure()) return;
      const h = document.createElement('div'); h.className = 'hl';
      Object.assign(h.style, {left: rect.x - 6 + 'px', top: rect.y - 6 + 'px', width: rect.width + 12 + 'px', height: rect.height + 12 + 'px'});
      root.append(h); requestAnimationFrame(() => h.classList.add('on'));
      setTimeout(() => { h.classList.remove('on'); setTimeout(() => h.remove(), 350); }, ms);
    },
  };
  ensure();
}

// Redaction / hiding, injected into every frame before page scripts run, so sensitive values are never
// rendered unblurred, not even for a frame.
function maskInit({redact, hide, blurPx}) {
  const rules = [];
  for (const r of redact) {
    const sel = typeof r === 'string' ? r : r.selector;
    const style = typeof r === 'string' ? `filter: blur(${blurPx}px) !important;` : (r.style ?? `filter: blur(${blurPx}px) !important;`);
    rules.push(`${sel} { ${style} }`);
  }
  for (const sel of hide) rules.push(`${sel} { visibility: hidden !important; }`);
  if (!rules.length) return;
  const css = rules.join('\n');
  const apply = () => {
    if (!document.documentElement) return;
    let s = document.getElementById('__stand_in_mask');
    if (!s) { s = document.createElement('style'); s.id = '__stand_in_mask'; s.textContent = css; }
    if (!s.isConnected) (document.head ?? document.documentElement).append(s);
  };
  apply();
  document.addEventListener('DOMContentLoaded', apply);
  new MutationObserver(apply).observe(document, {childList: true, subtree: true});
}

// ------------------------------------------------------------------------------------------
// Element inventory used by `inspect` and on step failure.
// ------------------------------------------------------------------------------------------
function collectElements() {
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],' +
    '[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[role=searchbox],' +
    '[role=textbox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  const roleOf = el => el.getAttribute('role') ?? ({A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox',
    SUMMARY: 'button'}[el.tagName] ?? (el.tagName === 'INPUT' ? ({checkbox: 'checkbox', radio: 'radio', submit: 'button',
    button: 'button', search: 'searchbox', range: 'slider'}[el.type] ?? 'textbox') : el.tagName.toLowerCase()));
  const nameOf = el => {
    const lb = el.getAttribute('aria-labelledby');
    const t = el.getAttribute('aria-label') ?? (lb && document.getElementById(lb)?.textContent) ??
      (el.labels?.[0]?.textContent) ?? (el.tagName === 'INPUT' && ['submit', 'button'].includes(el.type) ? el.value : null) ??
      el.innerText ?? el.getAttribute('placeholder') ?? el.getAttribute('title') ?? el.getAttribute('alt') ?? '';
    return t.replace(/\s+/g, ' ').trim().slice(0, 80);
  };
  const out = [];
  const found = new Set(document.querySelectorAll(sel));
  // Custom widgets (cards, rows, tiles) are often plain divs: catch them by cursor style or draggable.
  let scanned = 0;
  for (const el of document.body?.querySelectorAll('*') ?? []) {
    if (++scanned > 4000) break;
    if (found.has(el) || el.closest('demo-overlay')) continue;
    const c = getComputedStyle(el).cursor;
    if ((['pointer', 'grab', 'move'].includes(c) || el.draggable) && !(el.parentElement && getComputedStyle(el.parentElement).cursor === c))
      found.add(el);
  }
  for (const el of found) {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || cs.display === 'none') continue;
    const role = roleOf(el), name = nameOf(el);
    const item = {role, name, tag: el.tagName.toLowerCase()};
    if (el.id) item.css = `#${CSS.escape(el.id)}`;
    else if (el.getAttribute('data-testid')) item.css = `[data-testid="${el.getAttribute('data-testid')}"]`;
    else if (el.name) item.css = `${el.tagName.toLowerCase()}[name="${el.name}"]`;
    if (el.placeholder) item.placeholder = el.placeholder;
    if (el.href) item.href = el.href.slice(0, 120);
    item.box = [r.x, r.y, r.width, r.height].map(Math.round);
    item.inViewport = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    out.push(item);
  }
  const headings = [...document.querySelectorAll('h1,h2,h3')].map(h => h.innerText.trim()).filter(Boolean).slice(0, 25);
  return {title: document.title, url: location.href, scrollHeight: document.documentElement.scrollHeight,
    viewport: [innerWidth, innerHeight], headings, elements: out.slice(0, 250)};
}

// ------------------------------------------------------------------------------------------
// Capture by demonstration: runs in every frame while a person performs the flow in a visible
// browser. Each real (isTrusted) interaction is turned into a user-facing target and sent to Node.
// ------------------------------------------------------------------------------------------
function captureInit() {
  if (window.__demoCaptureInstalled) return;
  window.__demoCaptureInstalled = true;
  const send = ev => { try { window.__demoCaptureEvent?.({...ev, t: Date.now()}); } catch {} };
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],' +
    '[role=menuitemcheckbox],[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[role=textbox],' +
    '[role=searchbox],[contenteditable=""],[contenteditable=true]';
  const clean = s => (s ?? '').replace(/\s+/g, ' ').trim();
  const roleOf = el => el.getAttribute('role') ?? ({A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox',
    SUMMARY: 'button'}[el.tagName] ?? (el.tagName === 'INPUT' ? ({checkbox: 'checkbox', radio: 'radio', submit: 'button',
    button: 'button', search: 'searchbox', range: 'slider'}[el.type] ?? 'textbox') : null));
  const nameOf = el => {
    const lb = el.getAttribute('aria-labelledby');
    return clean(el.getAttribute('aria-label') ?? (lb && document.getElementById(lb)?.textContent) ?? el.labels?.[0]?.textContent ??
      (el.tagName === 'INPUT' && ['submit', 'button'].includes(el.type) ? el.value : null) ?? el.innerText ??
      el.getAttribute('title') ?? '');
  };
  const generated = s => /\d{3,}|[a-f0-9]{8,}|^(css|sc|jsx|ng|ember)-|__/i.test(s);
  const cssPath = el => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4; n = n.parentElement) {
      if (n.id && !generated(n.id)) { parts.unshift('#' + CSS.escape(n.id)); break; }
      let p = n.tagName.toLowerCase();
      const cls = [...n.classList].find(c => !generated(c));
      if (cls) p += '.' + CSS.escape(cls);
      const sib = n.parentElement ? [...n.parentElement.children].filter(c => c.tagName === n.tagName) : [];
      if (sib.length > 1 && !cls) p += `:nth-of-type(${sib.indexOf(n) + 1})`;
      parts.unshift(p);
    }
    return parts.join(' > ');
  };
  const targetFor = raw => {
    const el = raw.closest?.(INTERACTIVE) ?? raw;
    const tid = el.getAttribute?.('data-testid');
    if (tid) return {testId: tid};
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
      const lab = clean(el.labels?.[0]?.textContent);
      if (lab) return {label: lab};
      if (el.placeholder) return {placeholder: el.placeholder};
      if (el.getAttribute('aria-label')) return {role: roleOf(el), name: el.getAttribute('aria-label')};
      if (el.id && !generated(el.id)) return {css: '#' + CSS.escape(el.id)};
      if (el.name) return {css: `${el.tagName.toLowerCase()}[name="${el.name}"]`};
    }
    const role = roleOf(el), name = el.matches?.(INTERACTIVE) ? nameOf(el) : '';
    if (role && name && name.length <= 60) return {role, name};
    if (el.id && !generated(el.id)) return {css: '#' + CSS.escape(el.id)};
    const txt = clean(el.innerText);
    if (txt && txt.length <= 50) return {text: txt};
    return {css: cssPath(el)};
  };
  const isText = el => el && (el.tagName === 'TEXTAREA' || el.isContentEditable ||
    (el.tagName === 'INPUT' && !['checkbox', 'radio', 'submit', 'button', 'range', 'file', 'color'].includes(el.type)));
  let down = null;
  addEventListener('pointerdown', e => { if (e.isTrusted && e.button === 0) down = {x: e.clientX, y: e.clientY, el: e.target}; }, true);
  addEventListener('pointerup', e => {
    if (!e.isTrusted || !down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    if (moved > 12) {
      const over = document.elementFromPoint(e.clientX, e.clientY) ?? e.target;
      send({kind: 'drag', target: targetFor(down.el), to: targetFor(over)});
      down = {dragged: true};
      return;
    }
    down = null;
  }, true);
  addEventListener('click', e => {
    if (!e.isTrusted) return;
    if (down?.dragged) { down = null; return; }
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return;
    send({kind: 'click', target: targetFor(e.target), button: e.button === 2 ? 'right' : undefined});
  }, true);
  addEventListener('input', e => {
    if (!e.isTrusted || !isText(e.target)) return;
    const el = e.target, secret = el.type === 'password';
    send({kind: 'input', target: targetFor(el), value: secret ? '' : (el.isContentEditable ? el.innerText : el.value), secret});
  }, true);
  addEventListener('change', e => {
    if (!e.isTrusted || e.target.tagName !== 'SELECT') return;
    const o = e.target.selectedOptions[0];
    send({kind: 'select', target: targetFor(e.target), value: e.target.value, label: clean(o?.textContent)});
  }, true);
  addEventListener('keydown', e => {
    if (!e.isTrusted || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    const mod = (e.ctrlKey || e.metaKey) ? 'ControlOrMeta+' : '';
    const special = ['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End'];
    if (isText(e.target) && !mod && e.key !== 'Enter' && e.key !== 'Escape' && e.key !== 'Tab' && !e.key.startsWith('Arrow')) return;
    if (isText(e.target) && mod && ['a', 'c', 'v', 'x', 'z'].includes(e.key.toLowerCase())) return;
    if (!special.includes(e.key) && !mod) return;
    send({kind: e.key === 'Enter' && !mod && !e.shiftKey && isText(e.target) ? 'enter' : 'press',
      key: (e.shiftKey && mod ? 'Shift+' : '') + mod + (e.key.length === 1 ? e.key.toUpperCase() : e.key),
      target: isText(e.target) ? targetFor(e.target) : undefined});
  }, true);
  addEventListener('wheel', e => {
    if (!e.isTrusted) return;
    let sc = e.target;
    while (sc && sc !== document.body && sc !== document.documentElement &&
      !(/(auto|scroll)/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight)) sc = sc.parentElement;
    const inner = sc && sc !== document.body && sc !== document.documentElement;
    send({kind: 'wheel', dy: e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY, container: inner ? targetFor(sc) : null});
  }, {capture: true, passive: true});
}

// Turns the raw event stream into plan steps (coalescing typing, scrolls, double-clicks, and adding waits
// where the person paused to let something load or stream in).
class StepBuilder {
  constructor() { this.steps = []; this.typing = null; this.lastT = 0; this.lastWheelT = 0; this.secrets = 0; }
  same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  flush() {
    if (!this.typing) return;
    const {target, text, submit, secret} = this.typing;
    const step = {action: 'type', target, text: secret ? 'SET-ME: password (not captured)' : text};
    if (submit) step.submit = true;
    if (secret) this.secrets++;
    const prev = this.steps.at(-1);
    if (prev?.action === 'click' && this.same(prev.target, target)) this.steps.pop();
    this.steps.push(step);
    this.typing = null;
  }
  // A pause after something that triggers loading/streaming becomes a waitForStable on that frame.
  gap(t, frame) {
    const g = this.lastT ? t - this.lastT : 0;
    const prev = this.steps.at(-1);
    if (g > 2500 && prev && !['wait', 'waitForStable', 'scroll'].includes(prev.action)) {
      const triggers = ['click', 'press', 'select', 'drag'].includes(prev.action) || (prev.action === 'type' && prev.submit);
      const f = prev.target?.frame ?? frame;
      if (triggers) this.steps.push({action: 'waitForStable', target: f ? {frame: f, css: 'body'} : {css: 'body'}, pauseAfter: 2500,
        note: `captured: you paused ${(g / 1000).toFixed(1)}s here`});
      else this.steps.push({action: 'wait', ms: Math.min(Math.round(g / 100) * 100, 3000)});
    }
  }
  add(ev, frame) {
    const withFrame = tg => tg && frame ? {...tg, frame} : tg;
    const target = withFrame(ev.target);
    if (ev.kind !== 'input' && ev.kind !== 'enter') this.flush();
    if (!this.typing) this.gap(ev.t, frame);
    switch (ev.kind) {
      case 'input':
        if (this.typing && !this.same(this.typing.target, target)) this.flush();
        if (!this.typing) this.typing = {target, text: ev.value, secret: ev.secret};
        else this.typing.text = ev.value;
        break;
      case 'enter':
        if (this.typing && this.same(this.typing.target, target)) { this.typing.submit = true; this.flush(); }
        else { this.flush(); this.steps.push({action: 'press', key: 'Enter'}); }
        break;
      case 'click': {
        const prev = this.steps.at(-1);
        if (prev?.action === 'click' && this.same(prev.target, target) && ev.t - this.lastT < 450) prev.double = true;
        else this.steps.push({action: 'click', target, ...(ev.button ? {button: ev.button} : {})});
        break;
      }
      case 'select': {
        const prev = this.steps.at(-1);
        if (prev?.action === 'click' && this.same(prev.target, target)) this.steps.pop();
        this.steps.push({action: 'select', target, label: ev.label});
        break;
      }
      case 'press': this.steps.push({action: 'press', key: ev.key}); break;
      case 'drag': this.steps.push({action: 'drag', target, to: withFrame(ev.to)}); break;
      case 'wheel': {
        // No inner scroll container: inside an iframe it's that frame's own document that scrolls.
        const container = withFrame(ev.container) ?? (frame ? {frame, css: 'html'} : undefined);
        const prev = this.steps.at(-1);
        if (prev?.action === 'scroll' && this.same(prev.target, container) && ev.t - this.lastWheelT < 700) prev.by += ev.dy;
        else this.steps.push({action: 'scroll', by: ev.dy, ...(container ? {target: container} : {})});
        this.lastWheelT = ev.t;
        break;
      }
    }
    for (const s of this.steps) if (s.action === 'scroll') s.by = Math.round(s.by);
    this.lastT = ev.t;
  }
  snapshot() {
    const steps = this.steps.map(x => ({...x}));
    if (this.typing) steps.push({action: 'type', target: this.typing.target, text: this.typing.secret ? 'SET-ME: password (not captured)' : this.typing.text});
    return steps;
  }
  finish(t) { this.flush(); this.gap(t, null); this.steps = this.steps.filter(s => !(s.action === 'scroll' && Math.abs(s.by) < 20)); return this.steps; }
}

// Plain-text view of what's on screen (main page + visible iframes), so a person or an AI agent can verify a
// step without looking at images.
// Values shown inside `redact`ed elements (all frames), so text outputs can mask them like the video blurs them.
async function secretsOf(page, redact) {
  const sels = (redact ?? []).map(r => typeof r === 'string' ? r : r.selector).filter(Boolean);
  if (!sels.length) return [];
  const out = new Set();
  for (const f of page.frames()) {
    const vals = await f.evaluate(sels => sels.flatMap(sel => { try { return [...document.querySelectorAll(sel)]; } catch { return []; } })
      .flatMap(e => [e.innerText, e.textContent]).map(t => (t ?? '').trim()).filter(t => t.length >= 2), sels).catch(() => []);
    vals.forEach(v => out.add(v));
  }
  return [...out].sort((a, b) => b.length - a.length);
}
const maskText = (text, secrets) => secrets.reduce((t, v) => t.split(v).join('[redacted]'), text);

async function pageText(page, redact) {
  return maskText(await rawPageText(page), await secretsOf(page, redact));
}

async function rawPageText(page) {
  const grab = () => {
    const t = (document.body?.innerText ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return {title: document.title, url: location.href, text: t.length > 5000 ? t.slice(0, 5000) + '\n…(truncated)' : t};
  };
  const main = await page.evaluate(grab).catch(() => null);
  let out = main ? `URL: ${main.url}\nTITLE: ${main.title}\n\n${main.text}\n` : '';
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    const el = await f.frameElement().catch(() => null);
    if (!el || !(await el.isVisible().catch(() => false))) continue;
    const sub = await f.evaluate(grab).catch(() => null);
    const sel = await el.evaluate(n => n.id ? '#' + n.id : n.getAttribute('title') ? `iframe[title="${n.getAttribute('title')}"]` : 'iframe').catch(() => 'iframe');
    if (sub) out += `\n===== IFRAME ${sel} (${sub.url}) =====\n${sub.text}\n`;
  }
  return out;
}

// Page inventory, including visible iframes (embedded widgets such as an assistant panel).
async function inventory(page) {
  const inv = await page.evaluate(collectElements);
  inv.frames = [];
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    const el = await f.frameElement().catch(() => null);
    if (!el || !(await el.isVisible().catch(() => false))) continue;
    const frameSelector = await el.evaluate(n => n.id ? `#${CSS.escape(n.id)}` : n.getAttribute('name') ? `iframe[name="${n.getAttribute('name')}"]`
      : n.getAttribute('title') ? `iframe[title="${n.getAttribute('title')}"]` : n.getAttribute('src') ? `iframe[src="${n.getAttribute('src')}"]` : 'iframe');
    const sub = await f.evaluate(collectElements).catch(() => null);
    if (sub) inv.frames.push({frameSelector, url: f.url(), title: sub.title, elements: sub.elements});
  }
  return inv;
}

// ------------------------------------------------------------------------------------------
// Human-ish input
// ------------------------------------------------------------------------------------------
const PACE = {relaxed: 1.35, normal: 1, brisk: 0.7};
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Actor {
  constructor(page, plan) {
    this.page = page;
    this.plan = plan;
    this.k = PACE[plan.pace ?? 'normal'] ?? 1;
    const {width, height} = plan.viewport;
    this.mouse = {x: width * 0.55, y: height * 0.6};
  }
  wait(ms) { return this.page.waitForTimeout(Math.round(ms * this.k)); }

  locator(target) {
    const p = this.page;
    if (typeof target === 'string') return p.locator(target);
    const {role, name, text, label, placeholder, testId, css, exact, nth, within, frame} = target;
    // `frame`: CSS selector of an <iframe> (or an array, outermost first, for nested frames).
    let base = p;
    for (const f of frame == null ? [] : [].concat(frame)) base = base.frameLocator(f);
    if (within) base = this.locator(frame != null && typeof within === 'object' && within.frame == null ? {...within, frame} : within);
    let loc = role ? base.getByRole(role, name != null ? {name, exact: !!exact} : {})
      : text != null ? base.getByText(text, {exact: !!exact})
      : label != null ? base.getByLabel(label, {exact: !!exact})
      : placeholder != null ? base.getByPlaceholder(placeholder, {exact: !!exact})
      : testId != null ? base.getByTestId(testId)
      : css != null ? base.locator(css) : null;
    if (!loc) throw new Error(`Unrecognised target ${JSON.stringify(target)}`);
    return nth != null ? loc.nth(nth) : loc;
  }

  // Resolve to one visible element, bring it into view smoothly, return its box.
  async acquire(target, timeout) {
    let loc = this.locator(target);
    await loc.first().waitFor({state: 'visible', timeout});
    const count = await loc.count();
    if (count > 1) {
      // Prefer the first *visible* match rather than failing on ambiguity.
      for (let i = 0; i < count; i++) if (await loc.nth(i).isVisible()) { loc = loc.nth(i); break; }
    } else loc = loc.first();
    await this.bringIntoView(loc);
    const box = await this.trueBox(loc);
    if (!box) throw new Error('Element has no box (hidden or detached)');
    return {loc, box};
  }

  // Playwright's boundingBox() is wrong for elements inside iframes when the page uses CSS zoom, so
  // compute the on-screen box ourselves: element rect in its frame, then map through each parent iframe.
  async trueBox(loc) {
    const h = await loc.elementHandle().catch(() => null);
    if (!h) return null;
    let r = await h.evaluate(e => { const b = e.getBoundingClientRect(); return {x: b.x, y: b.y, width: b.width, height: b.height}; });
    for (let f = await h.ownerFrame(); f?.parentFrame(); f = f.parentFrame()) {
      const fe = await f.frameElement();
      const t = await fe.evaluate(n => {
        const b = n.getBoundingClientRect(), cs = getComputedStyle(n), k = n.offsetWidth ? b.width / n.offsetWidth : 1;
        return {x: b.x + (n.clientLeft + parseFloat(cs.paddingLeft)) * k, y: b.y + (n.clientTop + parseFloat(cs.paddingTop)) * k, k};
      });
      r = {x: t.x + r.x * t.k, y: t.y + r.y * t.k, width: r.width * t.k, height: r.height * t.k};
    }
    await h.dispose();
    return r;
  }

  async bringIntoView(loc) {
    const {width: W, height: H} = this.plan.viewport;
    const box = await this.trueBox(loc);
    if (box && box.y >= 60 && box.y + box.height <= H - 60 && box.x >= 0 && box.x + box.width <= W) return;
    await loc.evaluate(el => el.scrollIntoView({behavior: 'smooth', block: 'center', inline: 'nearest'}));
    // Wait for the smooth scroll to settle.
    let last = null;
    for (let i = 0; i < 60; i++) {
      await sleep(50);
      const b = await this.trueBox(loc);
      if (b && last && Math.abs(b.y - last.y) < 0.5 && Math.abs(b.x - last.x) < 0.5) break;
      last = b;
    }
    await this.wait(150);
  }

  // Eased, slightly curved cursor path.
  async glide(x, y, ms) {
    const from = {...this.mouse};
    const dist = Math.hypot(x - from.x, y - from.y);
    if (dist < 1) return;
    ms = (ms ?? Math.min(1100, Math.max(320, 260 + dist * 0.42))) * this.k;
    const bend = Math.min(60, dist * 0.12) * (Math.random() < 0.5 ? -1 : 1);
    const cx = (from.x + x) / 2 + (-(y - from.y) / dist) * bend, cy = (from.y + y) / 2 + ((x - from.x) / dist) * bend;
    const start = performance.now();
    for (;;) {
      const t = Math.min(1, (performance.now() - start) / ms);
      const e = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
      const px = (1 - e) ** 2 * from.x + 2 * (1 - e) * e * cx + e ** 2 * x;
      const py = (1 - e) ** 2 * from.y + 2 * (1 - e) * e * cy + e ** 2 * y;
      await this.page.mouse.move(px, py);
      if (t === 1) break;
      await sleep(8);
    }
    this.mouse = {x, y};
  }

  point(box, at) {
    // Aim a little off-centre like a person would; `at` = [fx, fy] fractions overrides.
    const [fx, fy] = at ?? [0.5 + (Math.random() - 0.5) * 0.15, 0.5 + (Math.random() - 0.5) * 0.2];
    return [box.x + box.width * fx, box.y + box.height * fy];
  }

  async click(step, timeout) {
    const {box} = await this.acquire(step.target, timeout);
    await this.glide(...this.point(box, step.at));
    await this.wait(110);
    const opts = {button: step.button ?? 'left'};
    for (let n = 1; n <= (step.double ? 2 : 1); n++) {
      await this.page.mouse.down({...opts, clickCount: n});
      await sleep(70);
      await this.page.mouse.up({...opts, clickCount: n});
      if (step.double && n === 1) await sleep(90);
    }
  }

  async type(step, timeout) {
    if (step.target) {
      const {box} = await this.acquire(step.target, timeout);
      await this.glide(...this.point(box, [0.3, 0.5]));
      await this.wait(90);
      await this.page.mouse.down(); await sleep(60); await this.page.mouse.up();
      await this.wait(160);
    }
    if (step.clear) {
      await this.page.keyboard.press('ControlOrMeta+A');
      await sleep(80);
      await this.page.keyboard.press('Backspace');
      await this.wait(150);
    }
    const base = step.delay ?? 65;
    for (const ch of step.text) {
      await this.page.keyboard.type(ch);
      let d = base * (0.55 + Math.random() * 0.9);
      if (ch === ' ') d += base * 0.4;
      if (/[.,!?;:@]/.test(ch)) d += base * 1.2;
      await sleep(d * this.k);
    }
    if (step.submit) { await this.wait(250); await this.page.keyboard.press('Enter'); }
  }

  async scroll(step, timeout) {
    const ms = (step.duration ?? 900) * this.k;
    if (step.to) {
      const loc = this.locator(step.to).first();
      await loc.waitFor({state: 'attached', timeout});
      // Our own eased scroll (so `duration` is honoured), clearing any sticky/fixed header for block:start.
      await loc.evaluate((el, {block, ms}) => {
        let sc = el.parentElement;
        while (sc && !(/(auto|scroll)/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight)) sc = sc.parentElement;
        const isDoc = !sc || sc === document.body || sc === document.documentElement;
        if (isDoc) sc = document.scrollingElement;
        const viewTop = isDoc ? 0 : sc.getBoundingClientRect().top;
        const viewH = isDoc ? innerHeight : sc.clientHeight;
        let header = 0;
        if (isDoc) {
          for (let n = document.elementFromPoint(innerWidth / 2, 2); n && n !== document.body; n = n.parentElement) {
            const pos = getComputedStyle(n).position;
            if (pos === 'fixed' || pos === 'sticky') { header = Math.max(0, n.getBoundingClientRect().bottom); break; }
          }
        }
        const r = el.getBoundingClientRect();
        const offset = block === 'start' ? header + 16 : block === 'end' ? viewH - r.height - 16 : (viewH + header - r.height) / 2;
        const max = sc.scrollHeight - sc.clientHeight;
        const start = sc.scrollTop, by = Math.max(-start, Math.min(max - start, r.top - viewTop - offset));
        return new Promise(res => {
          const t0 = performance.now();
          const tick = now => {
            const t = Math.min(1, (now - t0) / ms), e = t < .5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
            sc.scrollTop = start + by * e;
            t < 1 ? requestAnimationFrame(tick) : res();
          };
          requestAnimationFrame(tick);
        });
      }, {block: step.block ?? 'center', ms});
      return;
    }
    const by = step.by ?? (step.pages ?? 1) * this.plan.viewport.height * 0.8;
    const el = step.target ? this.locator(step.target).first() : await this.page.evaluateHandle(() => document.scrollingElement);
    // Eased scroll driven by rAF in the page: smoother on video than a burst of wheel events.
    await el.evaluate((sc, {by, ms}) => new Promise(res => {
      const start = sc.scrollTop, t0 = performance.now();
      const tick = now => {
        const t = Math.min(1, (now - t0) / ms), e = t < .5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
        sc.scrollTop = start + by * e;
        t < 1 ? requestAnimationFrame(tick) : res();
      };
      requestAnimationFrame(tick);
    }), {by, ms});
  }

  async drag(step, timeout) {
    const {box} = await this.acquire(step.target, timeout);
    await this.glide(...this.point(box, [0.5, 0.5]));
    await this.wait(120);
    await this.page.mouse.down();
    await sleep(120);
    let to;
    if (step.to?.x != null && step.to?.y != null && !step.to.role && !step.to.css) to = [step.to.x, step.to.y];
    else to = this.point((await this.acquire(step.to, timeout)).box, [0.5, 0.5]);
    await this.glide(to[0], to[1], step.duration ?? 1000);
    await sleep(120);
    await this.page.mouse.up();
  }

  async run(step, timeout) {
    const p = this.page;
    switch (step.action) {
      case 'goto': await p.goto(new URL(step.url, p.url()).href, {waitUntil: 'load', timeout: Math.max(timeout, 30000)}); break;
      case 'click': await this.click(step, timeout); break;
      case 'type': await this.type(step, timeout); break;
      case 'press': await p.keyboard.press(step.key); break;
      case 'hover': {
        const {box} = await this.acquire(step.target, timeout);
        await this.glide(...this.point(box, step.at));
        await this.wait(step.ms ?? 700);
        break;
      }
      case 'move': await this.glide(step.x, step.y, step.duration); break;
      case 'scroll': await this.scroll(step, timeout); break;
      case 'drag': await this.drag(step, timeout); break;
      case 'select': {
        // Native <select> popups are separate OS widgets and never appear in the recording, so show the
        // click on the control, then set the value directly.
        const {loc, box} = await this.acquire(step.target, timeout);
        await this.glide(...this.point(box, [0.5, 0.5]));
        await this.wait(150);
        await loc.selectOption(step.value != null ? {value: step.value} : {label: step.label});
        break;
      }
      case 'check': case 'uncheck': {
        const {loc} = await this.acquire(step.target, timeout);
        if ((await loc.isChecked()) !== (step.action === 'check')) await this.click(step, timeout);
        break;
      }
      case 'wait': await p.waitForTimeout(step.ms ?? 1000); break;
      case 'waitFor':
        if (step.target) await this.locator(step.target).first().waitFor({state: step.state ?? 'visible', timeout});
        else if (step.url) await p.waitForURL(step.url, {timeout});
        else await p.waitForLoadState(step.state ?? 'networkidle', {timeout});
        break;
      case 'waitForStable': {
        // For streamed content (chat/assistant answers): wait until the target stops changing for `quietMs`.
        const loc = step.target ? this.locator(step.target).last() : p.locator('body');
        await loc.waitFor({state: 'visible', timeout});
        const quiet = step.quietMs ?? 1500, limit = step.maxMs ?? 90000, t0 = performance.now();
        const minLen = step.minLength ?? 1;
        let last = '', since = performance.now();
        for (;;) {
          const sig = await loc.evaluate(el => {
            const busy = el.querySelector('[aria-busy="true"]') || el.closest('[aria-busy="true"]');
            return `${el.innerText.length}:${el.querySelectorAll('*').length}:${busy ? 'busy' : ''}`;
          }).catch(() => '');
          const len = parseInt(sig, 10) || 0;
          if (sig !== last || sig.endsWith('busy') || len < minLen) { last = sig; since = performance.now(); }
          else if (performance.now() - since >= quiet) break;
          if (performance.now() - t0 > limit) throw new Error(`waitForStable: still changing after ${limit}ms`);
          await sleep(150);
        }
        break;
      }
      case 'caption': await p.evaluate(t => window.__demoOverlay?.caption(t), step.text ?? null); break;
      case 'highlight': {
        const {box} = await this.acquire(step.target, timeout);
        const ms = step.ms ?? 1400;
        await p.evaluate(([b, ms]) => window.__demoOverlay?.highlight(b, ms), [box, ms]);
        await p.waitForTimeout(ms * 0.7);
        break;
      }
      case 'evaluate': await p.evaluate(step.js); break;
      default: throw new Error(`Unknown action "${step.action}"`);
    }
  }

  defaultPauseAfter(step) {
    return ({waitForStable: 900, click: 650, type: 500, press: 600, hover: 0, scroll: 450, drag: 700, select: 700, check: 550,
      uncheck: 550, goto: 600, caption: 250, highlight: 300, move: 150}[step.action] ?? 0);
  }

  // After anything that might navigate: let the new page settle and put the cursor back.
  async settle() {
    try { await this.page.waitForLoadState('load', {timeout: 15000}); } catch {}
    try { await this.page.evaluate(() => document.fonts?.ready); } catch {}
    try { await this.page.mouse.move(this.mouse.x, this.mouse.y); } catch {}
  }
}

const describe = s => {
  const t = s.target ?? s.to;
  const tt = t == null ? '' : typeof t === 'string' ? t : JSON.stringify(t);
  return s.note ?? [s.action, tt, s.text != null ? JSON.stringify(s.text) : '', s.key ?? '', s.url ?? ''].filter(Boolean).join(' ');
};

// ------------------------------------------------------------------------------------------
// Main
// ------------------------------------------------------------------------------------------
function log(...a) { console.error('[stand-in]', ...a); }
function die(msg) { console.error(`[stand-in] ERROR: ${msg}`); process.exit(1); }
const has = bin => spawnSync(bin, ['-version'], {stdio: 'ignore'}).status === 0;

// Plans can `extends` a shared profile (site defaults, login setup, redaction). Setup steps and
// redact/hide lists are concatenated (profile first); everything else in the child plan wins.
const PATH_KEYS = ['profileDir', 'storageState', 'output'];
async function loadPlan(file, seen = new Set()) {
  const abs = resolve(file);
  if (seen.has(abs)) die(`"extends" cycle at ${abs}`);
  seen.add(abs);
  let raw;
  try { raw = JSON.parse(await readFile(abs, 'utf8')); } catch (e) { die(`Cannot read plan ${abs}: ${e.message}`); }
  for (const k of PATH_KEYS) if (typeof raw[k] === 'string' && !/^[a-z]+:\/\//i.test(raw[k])) raw[k] = resolve(dirname(abs), raw[k].replace(/^~(?=\/)/, homedir()));
  // A url/loginUrl without a scheme is a local file relative to this JSON (handy for bundled sample sites).
  for (const k of ['url', 'loginUrl']) if (typeof raw[k] === 'string' && raw[k] && !/^[a-z][a-z0-9+.-]*:/i.test(raw[k]) && !raw[k].startsWith('SET-ME'))
    raw[k] = pathToFileURL(resolve(dirname(abs), raw[k])).href;
  if (!raw.extends) return raw;
  const base = await loadPlan(resolve(dirname(abs), raw.extends), seen);
  const {extends: _e, ...child} = raw;
  return {
    ...base, ...child,
    viewport: {...base.viewport, ...child.viewport},
    setup: [...(base.setup ?? []), ...(child.setup ?? [])],
    redact: [...(base.redact ?? []), ...(child.redact ?? [])],
    hide: [...(base.hide ?? []), ...(child.hide ?? [])],
    steps: child.steps ?? [],
  };
}

function normalisePlan(raw, urlOverride) {
  const plan = {
    viewport: {width: 1920, height: 1080}, zoom: 1, fps: 60, audio: false, cursor: true, pace: 'normal',
    leadInMs: 800, tailMs: 1500, timeout: 10000, setup: [], steps: [], redact: [], hide: [], ...raw,
  };
  if (urlOverride) plan.url = urlOverride;
  if (!plan.url) die('Plan has no "url".');
  if (String(plan.url).startsWith('SET-ME')) die('The site profile still has a "SET-ME" url: open it and put in the real URL.');
  plan.viewport = {width: 1920, height: 1080, ...plan.viewport};
  plan.overlay = {cursor: plan.cursor !== false, keepAlive: plan.constantFrameRate !== false, accent: plan.accent ?? '#f5b400', cursorColor: '#ffffff', cursorStroke: '#111111',
    captionSize: Math.round(plan.viewport.height / 1080 * 34), ...(plan.overlay ?? {})};
  return plan;
}

// Interactive one-time sign-in: opens a visible Chrome on a persistent profile; the person signs in
// (SSO, MFA, "remember this device"), then closes the window. Later runs reuse the profile headlessly.
// Creates sites/<name>.json (and, with --signed-in, sites/<name>-signed-in.json that extends it).
async function initSite(name, url, signedIn) {
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) die('usage: record.mjs init-site <name: lowercase-with-dashes> <url> [--signed-in]');
  await mkdir('sites', {recursive: true});
  const base = join('sites', `${name}.json`);
  const created = [];
  if (!existsSync(base)) {
    await writeFile(base, JSON.stringify({
      url: url ?? 'SET-ME: start page URL',
      zoom: 1, pace: 'normal', hide: [], setup: [],
      notes: 'What you have learned about this site (element names, iframes, pop-ups) for future demos.',
    }, null, 2) + '\n');
    created.push(base);
  } else log(`${base} already exists; leaving it as is.`);
  if (signedIn) {
    const si = join('sites', `${name}-signed-in.json`);
    if (!existsSync(si)) {
      await writeFile(si, JSON.stringify({
        extends: `${name}.json`,
        url: 'SET-ME: page to start on once signed in',
        loginUrl: url ?? 'SET-ME: sign-in page URL',
        profileDir: `../.sessions/${name}`,
        redact: [],
      }, null, 2) + '\n');
      created.push(si);
    } else log(`${si} already exists; leaving it as is.`);
  }
  for (const f of created) log(`Created ${f}`);
  if (created.some(f => readFileSync(f, 'utf8').includes('SET-ME'))) log('Open it and replace any "SET-ME" values.');
  if (signedIn) log(`Then sign in once: record.mjs login --site ${name}-signed-in`);
}

async function loginFlow(chromium, chromePath, url, profileDir, timeoutMin) {
  await mkdir(profileDir, {recursive: true});
  const ctx = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath, headless: false, viewport: null, args: ['--window-size=1440,960'],
  }).catch(e => die(`Could not open a visible Chrome window (${e.message.split('\n')[0]}). Sign-in needs a desktop session ` +
    `(it can't run on a headless server), and the session folder must not be open in another Chrome.`));
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto(url).catch(() => {});
  log(`A Chrome window is open on ${url}.`);
  log(`Sign in there (complete any MFA and choose "remember this device" if offered), then CLOSE THE WINDOW.`);
  log(`Profile: ${profileDir}`);
  await Promise.race([
    new Promise(r => ctx.on('close', r)),
    sleep(timeoutMin * 60000).then(() => { log(`Timed out after ${timeoutMin} min; saving profile anyway.`); return ctx.close(); }),
  ]);
  log('Window closed. Profile saved; use it with "profileDir" in the plan.');
}

async function frameChain(frame) {
  const chain = [];
  for (let f = frame; f?.parentFrame(); f = f.parentFrame()) {
    const el = await f.frameElement().catch(() => null);
    if (!el) break;
    chain.unshift(await el.evaluate(n => n.id ? `#${CSS.escape(n.id)}` : n.getAttribute('name') ? `iframe[name="${n.getAttribute('name')}"]`
      : n.getAttribute('title') ? `iframe[title="${n.getAttribute('title')}"]` : n.getAttribute('src') ? `iframe[src="${n.getAttribute('src')}"]` : 'iframe'));
  }
  return chain.length === 0 ? null : chain.length === 1 ? chain[0] : chain;
}

async function captureSteps({ctx, page, plan, captureFile, captureRaw}) {
  const builder = new StepBuilder();
  let queue = Promise.resolve();
  const save = async steps => {
    await mkdir(dirname(captureFile), {recursive: true});
    await writeFile(captureFile, JSON.stringify({...captureRaw, steps}, null, 2) + '\n');
  };
  if (captureRaw.steps?.length && existsSync(captureFile)) {
    await writeFile(captureFile.replace(/\.json$/i, '') + '.before-capture.json', JSON.stringify(captureRaw, null, 2) + '\n');
  }
  await ctx.exposeBinding('__demoCaptureEvent', ({frame}, ev) => {
    queue = queue.then(async () => {
      const chain = await frameChain(frame).catch(() => null);
      builder.add(ev, chain);
      const typingStarted = ev.kind === 'input' && builder._last !== 'input';
      const shown = ev.kind === 'input' ? `typing into ${JSON.stringify(ev.target).slice(0, 80)}${ev.secret ? ' (password: not captured)' : ''}` :
        ev.kind === 'enter' ? `Enter (submits ${JSON.stringify(ev.secret ? '' : builder.steps.at(-1)?.text ?? '').slice(0, 60)})` :
        ev.kind === 'wheel' ? 'scroll' : `${ev.kind} ${JSON.stringify(ev.target ?? ev.key ?? '').slice(0, 90)}`;
      if ((ev.kind !== 'input' || typingStarted) && (ev.kind !== 'wheel' || builder._last !== 'wheel'))
        log(`  + ${shown}${chain ? `  (in frame ${JSON.stringify(chain)})` : ''}`);
      builder._last = ev.kind;
      await save(builder.snapshot());
    }).catch(e => log(`capture error: ${e.message}`));
  });
  await ctx.addInitScript(captureInit);
  for (const f of page.frames()) await f.evaluate(captureInit).catch(() => {});
  const badge = () => page.evaluate(() => window.__demoOverlay?.badge('● Capturing steps: close this window when done')).catch(() => {});
  await badge();
  page.on('load', badge);
  log('');
  log(`CAPTURING into ${captureFile}`);
  log('Do the demo in the browser window exactly as a user would. Click, type, scroll, and pause where the');
  log('viewer should wait (e.g. while the Assistant answers). Close the window (or tab) when you are done.');
  log('');
  await new Promise(r => { page.once('close', r); ctx.once('close', r); });
  await queue;
  const steps = builder.finish(Date.now());
  await save(steps);
  log(`Captured ${steps.length} steps → ${captureFile}`);
  if (builder.secrets) log(`NOTE: ${builder.secrets} password field(s) were not captured: they're marked SET-ME. Sign-in belongs in the profile's setup or a saved profile, not in a demo.`);
  log('Next: open the plan, tidy anything odd (e.g. add "pauseAfter" to linger), then "Rehearse current plan" and "Record current plan".');
}

function libraryPaths(planFile) {
  const abs = resolve(planFile), parts = abs.split(/[\\/]/), i = parts.lastIndexOf('demos');
  if (i < 0) return null;
  const root = parts.slice(0, i).join('/') || '/', rest = parts.slice(i + 1).join('/').replace(/\.json$/i, '');
  return {video: resolve(root, 'recordings', rest + '.mp4'), runDir: resolve(root, '.runs', rest)};
}

// Record (or rehearse) every plan under a folder, one at a time: parallel recordings compete for CPU.
async function runAll(dir, a) {
  const files = [];
  const walk = d => { for (const e of readdirSync(d, {withFileTypes: true})) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('.json')) files.push(p);
  } };
  try { walk(resolve(dir)); } catch (e) { die(`Cannot read ${dir}: ${e.message}`); }
  files.sort();
  if (!files.length) die(`No plan files under ${dir}`);
  const pass = ['rehearse', 'headful'].filter(k => a[k]).map(k => `--${k}`)
    .concat(a.chrome ? ['--chrome', a.chrome] : [], a.connect ? ['--connect', a.connect] : [], a.profile ? ['--profile', a.profile] : []);
  const rows = [];
  for (const f of files) {
    log(`=== ${f}`);
    const t = performance.now();
    const r = spawnSync(process.execPath, [process.argv[1], f, ...pass], {stdio: 'inherit'});
    const lib = libraryPaths(f);
    rows.push({plan: f, ok: r.status === 0, seconds: +((performance.now() - t) / 1000).toFixed(1), video: a.rehearse ? '' : lib?.video ?? ''});
  }
  console.log('\n' + rows.map(r => `${r.ok ? 'OK  ' : 'FAIL'}  ${r.plan}  (${r.seconds}s)${r.video && r.ok ? '  → ' + r.video : ''}`).join('\n'));
  process.exitCode = rows.every(r => r.ok) ? 0 : 1;
}

async function main() {
  const {values: a, positionals} = parseArgs({allowPositionals: true, options: {
    out: {type: 'string'}, output: {type: 'string'}, rehearse: {type: 'boolean'}, chrome: {type: 'string'},
    headful: {type: 'boolean'}, plan: {type: 'string'}, connect: {type: 'string'}, profile: {type: 'string'},
    'timeout-min': {type: 'string'}, extends: {type: 'string'}, headless: {type: 'boolean'}, site: {type: 'string'},
    'signed-in': {type: 'boolean'}, 'no-signed-in': {type: 'boolean'}, help: {type: 'boolean', short: 'h'},
  }});
  if (a.help || !positionals.length) {
    console.log(`usage:
  record.mjs init-site <name> <url> [--signed-in]     create sites/<name>.json (+ <name>-signed-in.json)
  record.mjs login --site <name>-signed-in            one-time manual sign-in into the site's browser session
  record.mjs inspect --site <name> [--out DIR]        (or: inspect <url> [--plan plan.json])
  record.mjs <plan.json> [--rehearse] [--out DIR] [--output file.mp4]
  record.mjs all [demosDir] [--rehearse]               every plan under demosDir (default ./demos), one at a time
  record.mjs capture <plan.json> --site <name>        do the flow yourself in a visible browser; steps are written to plan.json
common: --chrome PATH | --connect http://127.0.0.1:9222 | --headful`);
    return;
  }
  const mode = ['inspect', 'login', 'all', 'capture', 'init-site'].includes(positionals[0]) ? positionals[0] : 'run';
  const captureMode = mode === 'capture';
  if (mode === 'all') return runAll(positionals[1] ?? 'demos', a);
  if (mode === 'init-site') return initSite(positionals[1], positionals[2], a['signed-in']);
  const inspectMode = mode === 'inspect';
  // --site NAME is shorthand for sites/NAME.json (as --plan for inspect, --extends for capture, profile for login).
  const siteFile = a.site && resolve(/\.json$/i.test(a.site) ? a.site : join('sites', `${a.site}.json`));
  if (siteFile && !existsSync(siteFile)) die(`No site profile ${siteFile}. Create one with: record.mjs init-site <name> <url>`);
  if (siteFile) { if (inspectMode) a.plan ??= siteFile; if (captureMode) a.extends ??= siteFile; }

  if (mode === 'login') {
    let url = positionals[1], profileDir = a.profile && resolve(a.profile.replace(/^~(?=\/)/, homedir()));
    if (siteFile) {
      const site = await loadPlan(siteFile);
      url ??= site.loginUrl ?? site.url;
      profileDir ??= site.profileDir;
      if (!site.profileDir && !a.profile) die(`${siteFile} has no "profileDir": login is for signed-in site profiles (init-site <name> <url> --signed-in).`);
    }
    if (url?.startsWith('SET-ME')) die(`Fill in the URL in ${siteFile} first.`);
    if (!url || !profileDir) die('usage: record.mjs login --site <signed-in site>   (or: record.mjs login <url> --profile DIR)');
    const {chromium, findChromeBinary} = await loadDeps();
    const chromePath = await findChrome(a.chrome, findChromeBinary);
    return loginFlow(chromium, chromePath, url, profileDir, +(a['timeout-min'] ?? 15));
  }

  let plan, captureFile, captureRaw;
  if (inspectMode) {
    const raw = a.plan ? await loadPlan(a.plan) : {};
    plan = normalisePlan({...raw, steps: []}, positionals[1] ?? raw.url);
  } else if (captureMode) {
    captureFile = positionals[1] && resolve(positionals[1]);
    if (!captureFile) die('usage: record.mjs capture <new-or-existing-plan.json> [--extends site-profile.json]');
    if (existsSync(captureFile)) {
      captureRaw = JSON.parse(await readFile(captureFile, 'utf8'));
      plan = normalisePlan({...(await loadPlan(captureFile)), steps: []});
    } else {
      if (!a.extends) die(`${captureFile} doesn't exist yet: pass --extends <site profile json> so it knows where to start.`);
      const rel = relative(dirname(captureFile), resolve(a.extends)).split('\\').join('/');
      captureRaw = {extends: rel, steps: []};
      plan = normalisePlan({...(await loadPlan(resolve(a.extends))), steps: []});
    }
    // The person drives a visible window: fit it on a laptop screen and don't draw a second cursor.
    // Shrink viewport and zoom by the same factor, so the page lays out exactly as it will when recorded.
    const f = Math.min(1, 1440 / plan.viewport.width, 860 / plan.viewport.height);
    plan.viewport = {width: Math.round(plan.viewport.width * f), height: Math.round(plan.viewport.height * f)};
    plan.zoom = (plan.zoom || 1) * f;
    plan.overlay = {...plan.overlay, cursor: false, keepAlive: false};
    plan.headful = !a.headless;
  } else {
    plan = normalisePlan(await loadPlan(positionals[0]));
  }
  if (a.profile) plan.profileDir = resolve(a.profile.replace(/^~(?=\/)/, homedir()));
  if (a.connect) plan.connect = a.connect;
  // Demo-library convention: <root>/demos/<sub>/<name>.json records to <root>/recordings/<sub>/<name>.mp4,
  // with working files (report, frames, contact sheet) in <root>/.runs/<sub>/<name>/.
  const lib = !inspectMode && !captureMode ? libraryPaths(positionals[0]) : null;
  const outDir = resolve(a.out ?? lib?.runDir ?? (inspectMode ? 'inspect' : captureMode ? join('.runs', 'capture') : 'recording'));
  if (!a.output && !plan.output && lib) plan.output = lib.video;
  await mkdir(outDir, {recursive: true});

  const {chromium, startRecording, findChromeBinary} = await loadDeps();
  const headful = a.headful ?? plan.headful ?? (platform() === 'darwin' && plan.fps > 60);
  const {width: W, height: H} = plan.viewport;
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const launchArgs = [`--window-size=${W},${H}`, '--hide-scrollbars', '--enable-gpu-rasterization',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    ...(plan.audio ? ['--autoplay-policy=no-user-gesture-required'] : []), ...(plan.chromeArgs ?? [])];
  const ctxOpts = {
    viewport: {width: W, height: H}, deviceScaleFactor: 1, colorScheme: plan.colorScheme, locale: plan.locale,
    ignoreHTTPSErrors: !!plan.ignoreHTTPSErrors,
  };

  // Three ways to get a browser:
  //  connect    → attach to a Chrome the person already launched and signed into (we open + close one tab)
  //  profileDir → persistent profile from `record.mjs login` (keeps SSO/MFA cookies between runs)
  //  default    → fresh, throwaway browser (optionally seeded with storageState)
  let browser, ctx, page, version, cleanup;
  if (plan.connect) {
    browser = await chromium.connectOverCDP(plan.connect).catch(e => die(
      `Could not attach to Chrome at ${plan.connect} (${e.message.split('\n')[0]}). Start Chrome ${MIN_CHROME}+ with ` +
      `--remote-debugging-port=9222 --user-data-dir=<a dedicated demo profile dir>.`));
    version = browser.version();
    if ((parseInt(version, 10) || 0) < MIN_CHROME) die(`Attached Chrome is ${version}; need ${MIN_CHROME}+ for native recording.`);
    ctx = browser.contexts()[0] ?? await browser.newContext();
    page = await ctx.newPage();
    await page.setViewportSize({width: W, height: H});
    cleanup = async () => { await page.close().catch(() => {}); await browser.close().catch(() => {}); };
  } else {
    const chromePath = await findChrome(a.chrome ?? plan.chrome, findChromeBinary);
    const launch = {executablePath: chromePath, headless: !headful, args: launchArgs,
      proxy: proxy ? {server: proxy, bypass: process.env.NO_PROXY ?? process.env.no_proxy} : undefined};
    if (plan.profileDir) {
      if (!existsSync(plan.profileDir)) die(`profileDir ${plan.profileDir} does not exist. Create it first with: record.mjs login <url> --profile ${plan.profileDir}`);
      ctx = await chromium.launchPersistentContext(plan.profileDir, {...launch, ...ctxOpts}).catch(e => die(
        `Could not open profile ${plan.profileDir} (${e.message.split('\n')[0]}). Is another Chrome using it? Close it and retry.`));
      for (const p of ctx.pages()) await p.close().catch(() => {});
      version = `${chromeMajor(chromePath)}`;
      cleanup = () => ctx.close().catch(() => {});
    } else {
      browser = await chromium.launch(launch);
      version = browser.version();
      ctx = await browser.newContext({...ctxOpts, ...(plan.storageState ? {storageState: plan.storageState} : {})});
      cleanup = () => browser.close().catch(() => {});
    }
    page = await ctx.newPage();
  }
  log(`Chrome ${version} (${plan.connect ? 'attached' : plan.profileDir ? 'profile' : headful ? 'headful' : 'headless'}) · ${W}x${H} @ ${plan.fps}fps`);

  await ctx.addInitScript(overlayInit, plan.overlay);
  await ctx.addInitScript(maskInit, {redact: plan.redact, hide: plan.hide, blurPx: plan.blurPx ?? 10});
  if (plan.zoom && plan.zoom !== 1) {
    await ctx.addInitScript(z => { if (window.top !== window) return; const set = () => document.documentElement && (document.documentElement.style.zoom = z);
      set(); document.addEventListener('DOMContentLoaded', set); }, String(plan.zoom));
  }
  // Keep everything in one recorded tab: follow links that try to open a new tab/window.
  ctx.on('page', async popup => {
    if (popup === page) return;
    // When attached to someone's own Chrome, leave their other tabs alone.
    if (plan.connect && (await popup.opener().catch(() => null)) !== page) return;
    try { await popup.waitForURL(u => u.href !== 'about:blank', {timeout: 5000}); } catch {}
    const url = popup.url(); await popup.close().catch(() => {});
    if (url && url !== 'about:blank') { log(`Popup redirected into main tab: ${url}`); await page.goto(url).catch(() => {}); }
  });
  page.on('dialog', d => { log(`Dialog (${d.type()}): ${d.message()} → accepted`); setTimeout(() => d.accept().catch(() => {}), 600); });

  const actor = new Actor(page, plan);
  const report = {url: plan.url, chrome: version, mode: inspectMode ? 'inspect' : a.rehearse ? 'rehearse' : 'record', steps: []};
  const finish = async code => {
    await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    await cleanup();
    process.exitCode = code;
  };

  // ---- load + setup (never recorded) ----
  try {
    await page.goto(plan.url, {waitUntil: 'load', timeout: 45000});
  } catch (e) {
    report.error = `Could not load ${plan.url}: ${e.message.split('\n')[0]}`;
    log(report.error); return finish(1);
  }
  await page.waitForLoadState('networkidle', {timeout: 6000}).catch(() => {});
  await actor.settle();

  const runSteps = async (steps, phase, rec) => {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i], label = `${phase}[${i}] ${describe(step)}`;
      const entry = {phase, index: i, action: step.action, description: describe(step)};
      if (rec) entry.t = (performance.now() - rec.t0) / 1000;
      try {
        await actor.run(step, step.timeout ?? plan.timeout);
        await actor.settle();
        await actor.wait(step.pauseAfter ?? actor.defaultPauseAfter(step));
        entry.ok = true;
      } catch (e) {
        if (step.optional) { entry.ok = true; entry.skipped = String(e.message).split('\n')[0]; log(`skip (optional) ${label}`); }
        else {
          entry.ok = false; entry.error = String(e.message).split('\n').slice(0, 3).join(' ');
          report.steps.push(entry);
          log(`FAILED ${label}\n  ${entry.error}`);
          await page.screenshot({path: join(outDir, 'failure.png')}).catch(() => {});
          await writeFile(join(outDir, 'failure.txt'), await pageText(page, plan.redact).catch(() => '')).catch(() => {});
          report.pageAtFailure = await inventory(page).catch(() => null);
          if (report.pageAtFailure) report.pageAtFailure = JSON.parse(maskText(JSON.stringify(report.pageAtFailure), await secretsOf(page, plan.redact)));
          return false;
        }
      }
      if (rec) entry.tEnd = (performance.now() - rec.t0) / 1000;
      if (phase === 'steps' && (rec || a.rehearse)) {
        const base = join(outDir, 'steps', `${String(i + 1).padStart(2, '0')}-${step.action}`);
        await mkdir(dirname(base), {recursive: true});
        // Text after every step (cheap, fine while recording); screenshots only in rehearsals.
        await writeFile(base + '.txt', await pageText(page, plan.redact).catch(e => `(could not read page: ${e.message})`));
        entry.text = base + '.txt';
        if (!rec) { await page.screenshot({path: base + '.png'}).catch(() => {}); entry.screenshot = base + '.png'; }
      }
      report.steps.push(entry);
      log(`ok ${label}`);
    }
    return true;
  };

  if (!(await runSteps(plan.setup, 'setup'))) return finish(1);
  if (plan.setup.length) await actor.settle();

  if (captureMode) {
    await captureSteps({ctx, page, plan, captureFile, captureRaw});
    report.mode = 'capture';
    return finish(0);
  }

  if (inspectMode) {
    report.page = await inventory(page);
    report.page = JSON.parse(maskText(JSON.stringify(report.page), await secretsOf(page, plan.redact)));
    await writeFile(join(outDir, 'page.txt'), await pageText(page, plan.redact).catch(() => ''));
    await page.screenshot({path: join(outDir, 'page.png')});
    await page.screenshot({path: join(outDir, 'page-full.png'), fullPage: true}).catch(() => {});
    await writeFile(join(outDir, 'elements.json'), JSON.stringify(report.page, null, 2));
    log(`Wrote ${join(outDir, 'elements.json')}, page.txt, page.png, page-full.png`);
    return finish(0);
  }

  if (a.rehearse) {
    await rm(join(outDir, 'steps'), {recursive: true, force: true});
    const ok = await runSteps(plan.steps, 'steps');
    log(ok ? `Rehearsal passed. Screenshots in ${join(outDir, 'steps')}` : 'Rehearsal failed: see report.json / failure.png');
    return finish(ok ? 0 : 1);
  }

  // ---- record ----
  await page.mouse.move(actor.mouse.x, actor.mouse.y);
  await page.waitForTimeout(300);
  const videoPath = resolve(a.output ?? plan.output ?? join(outDir, 'recording.mp4'));
  await rm(join(outDir, 'steps'), {recursive: true, force: true});
  const rec = await startRecording(page, {frameRate: plan.fps, maxWidth: W, maxHeight: H, audio: !!plan.audio});
  rec.t0 = performance.now();
  await page.waitForTimeout(plan.leadInMs);
  const ok = await runSteps(plan.steps, 'steps', rec);
  if (ok) {
    await page.evaluate(() => window.__demoOverlay?.caption(null)).catch(() => {});
    await page.waitForTimeout(plan.tailMs);
  }
  const t = performance.now();
  const buf = await rec.stop();
  report.stopMs = Math.round(performance.now() - t);
  const target = ok ? videoPath : videoPath.replace(/\.mp4$/i, '') + '.partial.mp4';
  await mkdir(dirname(target), {recursive: true});
  await writeFile(target, buf);
  report.video = {path: target, bytes: (await stat(target)).size, durationS: +((performance.now() - rec.t0) / 1000).toFixed(2)};

  if (has('ffprobe')) {
    const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=codec_name,width,height,avg_frame_rate:format=duration,bit_rate', '-of', 'json', target], {encoding: 'utf8'});
    try {
      const j = JSON.parse(r.stdout), s = j.streams[0];
      const [n, d] = s.avg_frame_rate.split('/').map(Number);
      Object.assign(report.video, {codec: s.codec_name, width: s.width, height: s.height, fps: +(n / d).toFixed(1),
        durationS: +(+j.format.duration).toFixed(2), mbps: +(j.format.bit_rate / 1e6).toFixed(1)});
    } catch {}
  }
  // Frames for verification: one per step, captured just before the next step begins.
  if (ok && has('ffmpeg')) {
    const framesDir = join(outDir, 'frames');
    await rm(framesDir, {recursive: true, force: true});
    await mkdir(framesDir, {recursive: true});
    const steps = report.steps.filter(s => s.phase === 'steps' && s.tEnd != null);
    const times = steps.map(s => Math.max(0, s.tEnd - 0.1));
    times.unshift(0.3);
    times.forEach((ts, i) => spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', ts.toFixed(2), '-i', target, '-frames:v', '1',
      join(framesDir, `${String(i).padStart(2, '0')}.png`)]));
    const cols = Math.min(4, times.length), rows = Math.ceil(times.length / cols);
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-framerate', '1', '-i', join(framesDir, '%02d.png'), '-vf',
      `scale=640:-2,pad=iw+8:ih+8:4:4:color=0x222222,tile=${cols}x${rows}:color=0x222222`, '-frames:v', '1',
      join(outDir, 'contact-sheet.png')]);
    report.contactSheet = join(outDir, 'contact-sheet.png');
    report.contactSheetNote = 'Tile 0 = start of video; tile N = end of step N.';
  }
  log(ok ? `Saved ${target}` : `Recording stopped early; partial video at ${target}`);
  log(JSON.stringify(report.video));
  return finish(ok ? 0 : 1);
}

main().catch(e => die(e.stack ?? String(e)));
