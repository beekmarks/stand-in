#!/usr/bin/env node
// Capture a website tab and optionally replay its recorded actions with visual effects.

import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync, realpathSync, rmSync} from 'node:fs';
import {mkdir, open, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {homedir, platform} from 'node:os';
import {basename, dirname, join, relative, resolve} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';

const MIN_CHROME = 153;

// A problem the person can fix themselves. Printed as a plain message, without a stack trace.
class UserError extends Error {
  // `link`: a page that fixes the problem (VS Code offers a button for it).
  constructor(message, {link} = {}) { super(message); this.link = link; }
}
// The person stopped before anything was recorded: not a failure, nothing to report.
class Cancelled extends UserError {}
const CRASHED = 'The Chrome tab crashed, usually because it ran out of memory. Very busy pages (videos, animations)' +
  ' are the hardest to record; try a shorter recording, or set "fps": 30 in the plan for replays.';

// ------------------------------------------------------------------------------------------
// Dependencies are installed with the package.
// ------------------------------------------------------------------------------------------
async function loadDeps() {
  const pw = await import('playwright-core');
  return {chromium: pw.chromium ?? pw.default.chromium};
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
async function findChrome(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  candidates.push(...standardChromePaths());
  // Chrome for Testing downloaded by Puppeteer (npx @puppeteer/browsers install chrome@stable).
  const puppeteer = join(homedir(), '.cache', 'puppeteer', 'chrome');
  try {
    for (const e of readdirSync(puppeteer).sort((a, b) => b.localeCompare(a, undefined, {numeric: true}))) {
      for (const sub of ['chrome-linux64/chrome', 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-win64/chrome.exe'])
        candidates.push(join(puppeteer, e, sub));
    }
  } catch {}
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
  if (explicit && !existsSync(explicit)) throw new UserError(`There is no Chrome at ${explicit}.`);
  const found = tried.length ? ` (found ${tried.join(', ')})` : '';
  throw new UserError(tried.length
    ? `Stand-in needs Google Chrome ${MIN_CHROME} or newer${found}. Update Chrome (Help > About Google Chrome), then try again.`
    : 'Stand-in needs Google Chrome, which isn\'t installed. Install it from https://www.google.com/chrome/, then try again.',
  {link: 'https://www.google.com/chrome/'});
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
    const style = document.createElement('style');
    style.textContent = css;
    caption = document.createElement('div');
    caption.className = 'cap';
    root.append(style, caption);
    if (opts.keepAlive) {
      const keepAlive = document.createElement('div');
      keepAlive.className = 'ka';
      root.append(keepAlive);
    }
    if (opts.cursor) {
      cursor = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      cursor.setAttribute('class', 'cur');
      cursor.setAttribute('viewBox', '0 0 24 24');
      const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      shape.setAttribute('d', 'M3 2 L3 19.5 L7.9 15 L11.3 22.4 L14.6 20.9 L11.2 13.6 L18 13.6 Z');
      shape.setAttribute('fill', opts.cursorColor);
      shape.setAttribute('stroke', opts.cursorStroke);
      shape.setAttribute('stroke-width', '1.5');
      shape.setAttribute('stroke-linejoin', 'round');
      cursor.append(shape);
      root.append(cursor);
    }
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

function captureInit() {
  if (window.__demoCaptureInstalled) return;
  window.__demoCaptureInstalled = true;
  const send = ev => window.__demoCaptureEvent?.({...ev, t: Date.now()})
    .catch(error => console.error(`Stand-in could not capture an action: ${error.message}`));
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],' +
    '[role=menuitemcheckbox],[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[role=textbox],' +
    '[role=searchbox],[contenteditable=""],[contenteditable=true]';
  const clean = s => (s ?? '').replace(/\s+/g, ' ').trim();
  const roleOf = el => el.getAttribute('role') ?? ({A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox',
    SUMMARY: 'button'}[el.tagName] ?? (el.tagName === 'INPUT' ? ({checkbox: 'checkbox', radio: 'radio', submit: 'button',
    button: 'button', search: 'searchbox', range: 'slider'}[el.type] ?? 'textbox') : null));
  // Text as screen readers (and Playwright) read it: parts hidden from them with aria-hidden are left out,
  // such as GitHub's "Issues 5k+ (5k+)", whose name is "Issues (5k+)".
  const spokenText = el => {
    if (!el.querySelector?.('[aria-hidden="true"]')) return clean(el.innerText);
    const parts = [];
    const walk = node => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) parts.push(child.textContent);
        else if (child.nodeType === 1 && child.getAttribute('aria-hidden') !== 'true' && !/^(SCRIPT|STYLE|TEMPLATE)$/.test(child.tagName) &&
          child.checkVisibility?.() !== false) walk(child);
      }
    };
    walk(el);
    return clean(parts.join(' ').replace(/\s+([)\].,!?:;])/g, '$1').replace(/([(\[])\s+/g, '$1'));
  };
  // Text shown in a web component's slots belongs to the button inside it, as screen readers (and Playwright) see it.
  const textOf = el => {
    const own = spokenText(el);
    if (own) return own;
    const slotted = clean([...el.querySelectorAll?.('slot') ?? []].flatMap(s => s.assignedNodes({flatten: true}))
      .map(n => n.textContent).join(' '));
    return slotted || clean(el.textContent);
  };
  // A <label> that wraps its control also contains the control's text (a select's options): leave that out.
  const labelText = el => {
    const label = el.labels?.[0];
    if (!label) return '';
    const copy = label.cloneNode(true);
    copy.querySelectorAll('select,input,textarea,button,datalist').forEach(n => n.remove());
    return clean(copy.textContent);
  };
  const nameOf = el => {
    const byId = id => el.getRootNode().getElementById?.(id) ?? document.getElementById(id);
    const labelledBy = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
      .map(id => byId(id)).filter(Boolean).map(textOf).join(' ');
    return [el.getAttribute('aria-label'), labelledBy, labelText(el),
      el.tagName === 'INPUT' && ['submit', 'button'].includes(el.type) ? el.value : null, textOf(el), el.getAttribute('title')]
      .map(clean).find(Boolean) ?? '';
  };
  // Ids and class names made up by frameworks or ad scripts ("css-1x2y3z", "offer-0-9OOTW") change between visits.
  // (Also styled-components hashes such as "ieGDnl".)
  // React's ids (":r1:", "«r1»", "_R_5l7d_") and random tokens ("WBVvC") change on every visit.
  const randomPart = p => p.length >= 4 && ((/\d/.test(p) && /[A-Z]/.test(p.slice(1))) ||
    (p.length <= 10 && (p.match(/[A-Z]/g) ?? []).length >= 2 && /[a-z]/.test(p) && !/^[A-Z]?[a-z]+(?:[A-Z][a-z]+)*$/.test(p)));
  const generated = s => /\d{3,}|[a-f0-9]{8,}|^(css|sc|jsx|ng|ember)-|__|^(?::r|«r|_r_)/i.test(s) ||
    s.split(/[-_:.]/).some(randomPart) ||
    (/^[a-zA-Z]{5,8}$/.test(s) && (s.match(/[A-Z]/g) ?? []).length >= 2);
  // Events from inside web components (shadow DOM) are retargeted to the component; use the real element.
  const real = e => e.composedPath?.()[0] ?? e.target;
  const up = n => n.parentElement ?? (n.parentNode instanceof ShadowRoot ? n.parentNode.host : null);
  const closestAcross = (el, selector) => {
    for (let n = el; n && n.nodeType === 1; n = up(n)) if (n.matches(selector)) return n;
    return null;
  };
  // Every element in the document, including inside open shadow roots, in document order (as Playwright sees them).
  const allIn = (root, selector, out = []) => {
    for (const n of root.querySelectorAll('*')) {
      if (n.matches(selector)) out.push(n);
      if (n.shadowRoot) allIn(n.shadowRoot, selector, out);
    }
    return out;
  };
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
    // Playwright's CSS engine looks inside open shadow roots, so "component inner > path" finds the element.
    const host = el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null;
    return (host ? cssPath(host) + ' ' : '') + parts.join(' > ');
  };
  // Several elements can share a role and name ("Read more" on every card): remember which one was used.
  // Hidden copies (a mobile menu, a duplicate table) aren't in the accessibility tree, so Playwright doesn't count them.
  const exposed = n => n.checkVisibility?.({visibilityProperty: true}) !== false && !closestAcross(n, '[aria-hidden="true"]');
  const withIndex = (target, el, role, name) => {
    const same = allIn(document, INTERACTIVE).filter(n => roleOf(n) === role && exposed(n) && nameOf(n) === name);
    const i = same.indexOf(el);
    return same.length > 1 && i > 0 ? {...target, nth: i} : target;
  };
  // A link also remembers where it goes: that picks the right one when several links share a name ("Home"
  // in every menu), and still finds it when its name has changed ("Downtown Dallas Cloudy 53°").
  // Tracking codes ("utm_source", "_ga", "gclid") change on every visit, so they're left out.
  const TRACKING = /^(utm_|_ga$|_gl$|gclid$|fbclid$|msclkid$|mc_|_hs|amp(DeviceId|SessionId)$|_ics$|irclickid$|ref_?src$|icid$)/i;
  const untracked = href => {
    const q = href.indexOf('?');
    if (q < 0) return href;
    const [path, rest] = [href.slice(0, q), href.slice(q + 1)];
    const hash = rest.includes('#') ? rest.slice(rest.indexOf('#')) : '';
    const kept = rest.replace(/#.*$/, '').split('&').filter(p => p && !TRACKING.test(decodeURIComponent(p.split('=')[0])));
    return path + (kept.length ? '?' + kept.join('&') : '') + hash;
  };
  const targetFor = raw => {
    const t = targetOf(raw);
    const link = closestAcross(raw, 'a[href]');
    const written = link?.getAttribute('href');
    const href = written && untracked(written);
    if (t && link && href && href.length <= 300 && !/^(#|javascript:)/i.test(href) && !t.css && !t.testId) return {...t, href};
    return t;
  };
  const targetOf = raw => {
    const el = closestAcross(raw, INTERACTIVE) ?? raw;
    const tid = el.getAttribute?.('data-testid');
    // Many sites put the same test id on every item of a list; only a unique one identifies this element.
    if (tid && allIn(document, `[data-testid="${CSS.escape(tid)}"]`).length === 1) return {testId: tid};
    if (['TEXTAREA', 'SELECT'].includes(el.tagName) || (el.tagName === 'INPUT' && isText(el))) {
      const lab = labelText(el);
      if (lab) return {label: lab};
      if (el.placeholder) return {placeholder: el.placeholder};
      if (el.getAttribute('aria-label')) return {role: roleOf(el), name: el.getAttribute('aria-label')};
      if (el.id && !generated(el.id)) return {css: '#' + CSS.escape(el.id)};
      if (el.name) return {css: `${el.tagName.toLowerCase()}[name="${el.name}"]`};
    }
    // A text box's own content is not its name (it changes as you type), so find it by its place on the page.
    if (isText(el)) {
      const named = el.getAttribute('aria-label') ?? el.getAttribute('aria-placeholder');
      if (named) return {role: roleOf(el) ?? 'textbox', name: clean(named)};
      if (el.id && !generated(el.id)) return {css: '#' + CSS.escape(el.id)};
      return {css: cssPath(el)};
    }
    const role = roleOf(el), name = el.matches?.(INTERACTIVE) ? nameOf(el) : '';
    if (role && name && name.length <= 60) return withIndex({role, name}, el, role, name);
    // A long name (a search result with a description) still starts with something recognisable.
    const first = clean((el.innerText ?? '').split('\n').find(l => l.trim()));
    if (role && first && first.length <= 100 && first !== name) return {role, name: first};
    if (el.tagName === 'IMG' && clean(el.alt)) return {role: 'img', name: clean(el.alt)};
    // A long name on one line (a headline or product name): its start, cut at a word, still finds it, since
    // names match in part. That beats an id that only says where it sits in a list ("card-list-items_1-0").
    if (role && name && name.length > 60) {
      const start = name.slice(0, 60).replace(/\s+\S*$/, '');
      return {role, name: start.length >= 20 ? start : name.slice(0, 60)};
    }
    if (el.id && !generated(el.id)) return {css: '#' + CSS.escape(el.id)};
    // An unlabelled checkbox or radio button is still known by its form name (and value, in a radio group).
    if (['INPUT', 'BUTTON', 'SELECT'].includes(el.tagName) && el.name) {
      const t = el.tagName.toLowerCase(), q = v => JSON.stringify(v);
      return {css: `${t}[name=${q(el.name)}]${el.type === 'radio' ? `[value=${q(el.value)}]` : ''}`};
    }
    if (tid) return {testId: tid, nth: allIn(document, `[data-testid="${CSS.escape(tid)}"]`).indexOf(el)};
    const txt = clean(el.innerText);
    if (txt && txt.length <= 50) return {text: txt};
    return {css: cssPath(el)};
  };
  // A click that closes a banner, a cookie notice or a pop-up. These often don't appear again on replay
  // (the site remembers), so their steps become optional.
  // The whole name is one of these ("Accept all cookies", "No thanks", "×"), or it's short and says close or dismiss.
  const DISMISS_NAME = /^(?:x|×|✕|✖|close|dismiss|minimi[sz]e|hide|no,? thanks?|not now|maybe later|skip|got it|ok(?:ay)?|accept(?: all)?(?: cookies)?|i? ?agree|allow(?: all)?(?: cookies)?|reject(?: all)?(?: cookies)?|decline|continue without accepting)[.!]?$/i;
  const DISMISS = {test: s => DISMISS_NAME.test(s) || (s.length <= 30 && /\b(?:close|dismiss)\b/i.test(s))};
  const POPUP = /cookie|consent|gdpr|banner|modal|popup|pop-up|overlay|lightbox|backdrop|interstitial|survey|toast|newsletter|promo|offer|onetrust|didomi|cmp\b/i;
  // A pop-up is a dialog, or something that floats over the page (fixed or sticky) and is named like one.
  // The page itself doesn't count, even when <body> has a class such as "overlay-banner-open".
  const inPopup = el => {
    let named = false;
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 10; n = up(n), i++) {
      if (/^(BODY|HTML|MAIN)$/.test(n.tagName)) return false;
      if (n.matches('[role=dialog],[role=alertdialog],dialog,[aria-modal=true]')) return true;
      named ||= POPUP.test(`${n.id} ${typeof n.className === 'string' ? n.className : ''} ${n.getAttribute('aria-label') ?? ''}`);
      if (named && /^(fixed|sticky)$/.test(getComputedStyle(n).position)) {
        // A site's own header or navigation bar stays on screen too, but it isn't a pop-up.
        return !n.matches('header,nav,[role=banner],[role=navigation],[role=menubar]');
      }
    }
    return false;
  };
  const isDismiss = (el, name) => {
    if (DISMISS.test(clean(name)) || DISMISS.test(clean(el.getAttribute?.('title')))) return true;
    if (!inPopup(el)) return false;
    // A short button or link in a pop-up, or a click on the pop-up's backdrop, closes it.
    return (/^(?:button|link)$/.test(roleOf(el) ?? '') && clean(name).length <= 30) || !el.matches(INTERACTIVE);
  };
  const isText = el => el && (el.tagName === 'TEXTAREA' || el.isContentEditable ||
    (el.tagName === 'INPUT' && !['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'range', 'file', 'color'].includes(el.type)));
  let down = null;
  addEventListener('pointerdown', e => {
    if (e.isTrusted && e.button === 0) down = {x: e.clientX, y: e.clientY, el: real(e)};
  }, true);
  addEventListener('pointerup', e => {
    if (!e.isTrusted || !down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    if (moved > 12) {
      const over = document.elementFromPoint(e.clientX, e.clientY) ?? real(e);
      send({kind: 'drag', target: targetFor(down.el), to: targetFor(over)});
      down = {dragged: true};
      return;
    }
    down = null;
  }, true);
  // Menus that open when you point at a nav item: remember what was pointed at, so a click inside the menu
  // can be preceded by pointing at the item that opened it (replay can't reach a link in a closed menu).
  let pointed = [];
  const NAV = 'nav,ul,ol,[role=menubar],[role=navigation],header,body,html';
  // Where a nav item's menu would be: what it controls, or the wrapper it shares with its menu (a list item).
  const menuArea = h => {
    const ids = (h.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean);
    const controlled = ids.map(id => h.getRootNode().getElementById?.(id) ?? document.getElementById(id)).filter(Boolean);
    const wrapper = up(h);
    const wrapper2 = wrapper && !wrapper.matches(NAV) ? up(wrapper) : null;
    const shared = [wrapper2, wrapper].find(w => w && !w.matches(NAV));
    return [...controlled, ...(shared ? [shared] : [])];
  };
  const SHOWN_ITEMS = 'a[href],button,input,[role=menuitem],[role=link],[role=button]';
  const visibleIn = areas => areas.reduce((n, a) => n + [...a.querySelectorAll(SHOWN_ITEMS)].filter(x => {
    const r = x.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(x).visibility !== 'hidden';
  }).length, 0);
  // What could be clicked when each item was pointed at, so a click on something that wasn't there yet
  // shows it was revealed by pointing, even when the menu is drawn elsewhere on the page. Taken at most every
  // 300 ms, to stay quick on big pages.
  const canSee = el => el.checkVisibility?.({checkOpacity: true, checkVisibilityCSS: true}) ?? true;
  // On screen and not clipped or covered: the item itself is what's at its centre. (Something scrolled out
  // of view still counts: scrolling doesn't reveal menus.)
  const reallyShown = el => {
    if (!canSee(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return true;
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
  };
  let shown = {t: 0, set: null};
  const shownNow = () => {
    if (Date.now() - shown.t > 300) shown = {t: Date.now(), set: new WeakSet([...document.querySelectorAll(SHOWN_ITEMS)].filter(reallyShown))};
    return shown.set;
  };
  let lastAction = 0;
  addEventListener('keydown', e => { if (e.isTrusted && e.key !== 'Shift') { lastAction = Date.now(); shown.t = 0; } }, true);
  addEventListener('wheel', e => { if (e.isTrusted) { lastAction = Date.now(); shown.t = 0; } }, {capture: true, passive: true});
  addEventListener('mouseover', e => {
    if (!e.isTrusted) return;
    const el = closestAcross(real(e), INTERACTIVE);
    if (!el || el === pointed.at(-1)?.el) return;
    const areas = menuArea(el);
    pointed = [...pointed.filter(p => p.el !== el), {el, t: Date.now(), areas, before: visibleIn(areas), seen: shownNow()}].slice(-6);
  }, true);
  // The item most recently pointed at (since your last click or key press) that revealed the clicked item.
  const openedBy = el => {
    for (const p of [...pointed].reverse()) {
      if (p.el === el || p.t < lastAction || Date.now() - p.t > 20000 || !p.el.isConnected || p.el.contains(el) || el.contains(p.el)) continue;
      // Its menu holds the clicked item, and pointing showed something new there.
      if (p.areas.some(a => a.contains(el)) && visibleIn(p.areas) > p.before) return p.el;
      // Or the clicked item wasn't there to click when this was pointed at (a menu drawn elsewhere).
      // (Not just after a click or key, while what that brought up is still appearing.)
      if (p.seen && p.t - lastAction > 600 && !p.seen.has(el) && el.matches(SHOWN_ITEMS) && canSee(el)) return p.el;
    }
    return null;
  };
  // Enter in a form, or on a focused button, makes the browser click the button. That click comes from the
  // key, which is already a step; recording it too would click again on replay. (Space isn't a step, so a
  // click from Space is kept.)
  let lastKey = null;
  addEventListener('keydown', e => { if (e.isTrusted) lastKey = {key: e.key, t: Date.now()}; }, true);
  addEventListener('click', e => {
    if (!e.isTrusted) return;
    if (down?.dragged) { down = null; return; }
    if (e.detail === 0 && lastKey?.key === 'Enter' && Date.now() - lastKey.t < 1000) return;
    const t = real(e);
    if (t.tagName === 'SELECT' || t.tagName === 'OPTION') return;
    const el = closestAcross(t, INTERACTIVE) ?? t;
    const menu = openedBy(el);
    lastAction = Date.now();
    shown.t = 0;
    if (menu) send({kind: 'hover', target: targetFor(menu)});
    // A click on plain content (not a link, button or anything the site made clickable) is incidental, such
    // as clicking to focus the page; if that content isn't there on replay, carry on.
    const plain = !closestAcross(t, INTERACTIVE) && getComputedStyle(t).cursor !== 'pointer';
    send({kind: 'click', target: targetFor(t), button: e.button === 2 ? 'right' : undefined,
      dismiss: isDismiss(el, nameOf(el)) || plain || undefined});
  }, true);
  addEventListener('input', e => {
    const el = real(e);
    if (!e.isTrusted || !isText(el)) return;
    const secret = el.type === 'password';
    // A search box: what you type there brings up results, not a chat answer next to the box.
    const words = `${el.type ?? ''} ${el.getAttribute('role') ?? ''} ${el.name ?? ''} ${el.id ?? ''} ${el.getAttribute('aria-label') ?? ''} ${el.placeholder ?? ''}`;
    const search = el.type === 'search' || el.closest('[role=search],form[role=search]') != null || /\bsearch|searchbox|\bq\b|query|\bfind\b/i.test(words);
    send({kind: 'input', target: targetFor(el), value: secret ? '' : (el.isContentEditable ? el.innerText : el.value), secret, search: search || undefined});
  }, true);
  addEventListener('change', e => {
    const el = real(e);
    if (!e.isTrusted || el.tagName !== 'SELECT') return;
    const o = el.selectedOptions[0];
    send({kind: 'select', target: targetFor(el), value: el.value, label: clean(o?.textContent)});
  }, true);
  addEventListener('keydown', e => {
    if (!e.isTrusted || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'Digit9') return;
    const t = real(e);
    const mod = (e.ctrlKey || e.metaKey) ? 'ControlOrMeta+' : '';
    const special = ['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End'];
    if (isText(t) && !mod && e.key !== 'Enter' && e.key !== 'Escape' && e.key !== 'Tab' && !e.key.startsWith('Arrow')) return;
    if (isText(t) && mod && ['a', 'c', 'v', 'x', 'z'].includes(e.key.toLowerCase())) return;
    if (!special.includes(e.key) && !mod) return;
    send({kind: e.key === 'Enter' && !mod && !e.shiftKey && isText(t) ? 'enter' : 'press',
      key: (e.shiftKey && mod ? 'Shift+' : '') + mod + (e.key.length === 1 ? e.key.toUpperCase() : e.key),
      target: isText(t) ? targetFor(t) : undefined});
  }, true);
  const scrollable = n => /(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight;
  addEventListener('wheel', e => {
    if (!e.isTrusted) return;
    let sc = real(e);
    while (sc && sc !== document.body && sc !== document.documentElement && !scrollable(sc)) sc = up(sc);
    const inner = sc && sc !== document.body && sc !== document.documentElement;
    // Wheeling over an iframe that can't scroll itself (an ad, an embed) scrolls the page around it.
    const page = window.top !== window && !inner && document.scrollingElement.scrollHeight <= innerHeight + 1;
    send({kind: 'wheel', dy: e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY, container: inner ? targetFor(sc) : null,
      page: page || undefined});
  }, {capture: true, passive: true});
}

const PAUSE_MS = 3000; // longest pause kept from a recording, in the video and in its replay plan

class StepBuilder {
  constructor() {
    this.steps = []; this.typing = null; this.lastT = 0; this.lastWheelT = 0; this.secrets = 0; this.lastSubmit = null;
    this.navT = 0;
  }
  // The recorded tab's main page changed URL at time t (full load or single-page-app route change).
  noteNavigation(t) { this.navT = t; }
  same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  flush() {
    if (!this.typing) return;
    const {target, text, submit, secret, search} = this.typing;
    const step = {action: 'type', target, text: secret ? 'SET-ME: password (not captured)' : text, clear: true};
    if (search) (this.searchSteps ??= new WeakSet()).add(step);
    if (submit) step.submit = true;
    if (secret) this.secrets++;
    const prev = this.steps.at(-1);
    if (prev?.action === 'click' && this.same(prev.target, target)) this.steps.pop();
    this.steps.push(step);
    this.typing = null;
  }
  // A pause longer than 2.5 s becomes a wait. After a question is submitted in a text field (Enter, or a
  // click right after typing, such as Send) and the page stays put, the pause was almost certainly an
  // answer appearing, as in a chat assistant. Then the wait follows the answer around that field instead
  // of lasting a fixed time, so a slower answer on replay isn't cut off. `minMs` (about half your pause,
  // allowing for reading time) rides out "thinking" pauses where nothing on screen changes.
  gap(t) {
    const g = this.lastT ? t - this.lastT : 0;
    const prev = this.steps.at(-1);
    if (!(g > 2500 && prev && prev.action !== 'wait' && prev.action !== 'waitForStable')) return;
    const before = this.steps.at(-2);
    const asked = prev.action === 'type' && prev.submit ? prev
      : ['click', 'press'].includes(prev.action) && before?.action === 'type' && !before.submit ? before : null;
    // A search box brings up results, which take a fixed wait like any page; only a chat box gets an answer.
    const field = asked && !this.searchSteps?.has(asked) ? asked.target : null;
    const typed = String((prev.action === 'type' ? prev : before)?.text ?? '');
    const navigated = this.navT >= this.lastT && this.navT <= t;
    if (field && !navigated && !typed.startsWith('SET-ME')) {
      const minMs = Math.max(0, Math.min(15000, Math.round((g - 3000) * 0.5 / 100) * 100));
      this.steps.push({action: 'waitForStable', around: field, ...(minMs ? {minMs} : {}), pauseAfter: 2500,
        note: `captured: you waited ${(g / 1000).toFixed(1)}s for an answer here`});
    } else {
      // Anything else was hesitation, not something the viewer needs to see: keep at most 3 s of it.
      // (Waits for pages and answers are separate steps and keep their full length.)
      const ms = Math.round(g / 100) * 100;
      this.steps.push(ms > PAUSE_MS
        ? {action: 'wait', ms: PAUSE_MS, note: `captured: you paused ${(g / 1000).toFixed(1)}s here; shortened (raise ms to keep more)`}
        : {action: 'wait', ms});
    }
  }
  // Chat boxes often fire one more input event right after Enter (the newline, or the box being cleared).
  // That is part of submitting, not new typing; recording it would ask the question a second time.
  isSubmitEcho(ev, target) {
    const s = this.lastSubmit;
    if (ev.kind !== 'input' || !s || !this.same(s.target, target) || ev.t - s.t > 1500) return false;
    const v = String(ev.value ?? '').trim();
    return v === '' || v === String(s.text ?? '').trim();
  }
  add(ev, frame) {
    const withFrame = tg => tg && frame ? {...tg, frame} : tg;
    const target = withFrame(ev.target);
    if (this.isSubmitEcho(ev, target)) return false;
    if (ev.kind !== 'input') this.lastSubmit = null;
    if (ev.kind !== 'input' && ev.kind !== 'enter') this.flush();
    if (!this.typing) this.gap(ev.t, frame);
    switch (ev.kind) {
      case 'input':
        if (this.typing && !this.same(this.typing.target, target)) this.flush();
        if (!this.typing) this.typing = {target, text: ev.value, secret: ev.secret, search: ev.search};
        else this.typing.text = ev.value;
        break;
      case 'enter':
        if (this.typing && this.same(this.typing.target, target)) {
          this.typing.submit = true;
          this.lastSubmit = {target, text: this.typing.text, t: ev.t};
          this.flush();
        }
        else { this.flush(); this.steps.push({action: 'press', key: 'Enter'}); }
        break;
      case 'click': {
        const prev = this.steps.at(-1);
        if (prev?.action === 'click' && this.same(prev.target, target) && ev.t - this.lastT < 450) prev.double = true;
        // Closing a pop-up or banner: it may not appear on replay, so don't fail (or wait long) if it's missing.
        else this.steps.push({action: 'click', target, ...(ev.button ? {button: ev.button} : {}),
          ...(ev.dismiss ? {optional: true, timeout: 3000} : {})});
        break;
      }
      case 'select': {
        const prev = this.steps.at(-1);
        if (prev?.action === 'click' && this.same(prev.target, target)) this.steps.pop();
        this.steps.push({action: 'select', target, label: ev.label, ...(ev.value !== ev.label ? {value: ev.value} : {})});
        break;
      }
      case 'press': this.steps.push({action: 'press', key: ev.key}); break;
      // Pointing at a nav item opened the menu clicked next.
      case 'hover': {
        const prev = this.steps.at(-1);
        if (!(['click', 'hover'].includes(prev?.action) && this.same(prev.target, target)))
          // Only a help for the next click (which opens the menu itself if it must), so not worth failing over.
          this.steps.push({action: 'hover', target, ms: 500, optional: true, timeout: 3000});
        break;
      }
      case 'drag': this.steps.push({action: 'drag', target, to: withFrame(ev.to)}); break;
      case 'wheel': {
        // No inner scroll container: inside an iframe it's that frame's own document that scrolls.
        const container = ev.page ? undefined : withFrame(ev.container) ?? (frame ? {frame, css: 'html'} : undefined);
        const prev = this.steps.at(-1);
        if (prev?.action === 'scroll' && this.same(prev.target, container) && ev.t - this.lastWheelT < 700) prev.by += ev.dy;
        else this.steps.push({action: 'scroll', by: ev.dy, ...(container ? {target: container} : {})});
        this.lastWheelT = ev.t;
        break;
      }
    }
    for (const s of this.steps) if (s.action === 'scroll') s.by = Math.round(s.by);
    this.lastT = ev.t;
    return true;
  }
  snapshot() {
    const steps = this.steps.map(x => ({...x}));
    if (this.typing) steps.push({action: 'type', target: this.typing.target, text: this.typing.secret ? 'SET-ME: password (not captured)' : this.typing.text, clear: true});
    return steps;
  }
  finish(t) { this.flush(); this.gap(t, null); this.steps = this.steps.filter(s => !(s.action === 'scroll' && Math.abs(s.by) < 20)); return this.steps; }
}

const PACE = {relaxed: 1.35, normal: 1, brisk: 0.7};
const sleep = ms => new Promise(r => setTimeout(r, ms));
class AssistantResponseError extends Error {}

class Actor {
  constructor(page, plan) {
    this.page = page;
    this.plan = plan;
    this.k = PACE[plan.pace ?? 'normal'] ?? 1;
    const {width, height} = plan.viewport;
    this.mouse = {x: width * 0.55, y: height * 0.6};
    // When the page last started and finished going to a new address, so steps can wait for page loads.
    this.navStarted = 0; this.navCommitted = 0;
    page.on('request', r => {
      try { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) this.navStarted = Date.now(); } catch {}
    });
    page.on('framenavigated', f => { if (f === page.mainFrame()) this.navCommitted = Date.now(); });
  }
  wait(ms) { return this.page.waitForTimeout(Math.round(ms * this.k)); }

  // `hidden`: also match elements that aren't visible, such as links in a closed menu.
  locator(target, {hidden = false} = {}) {
    const p = this.page;
    if (typeof target === 'string') return p.locator(target);
    const {role, name, text, label, placeholder, testId, css, exact, nth, within, frame} = target;
    // `frame`: CSS selector of an <iframe> (or an array, outermost first, for nested frames).
    let base = p;
    for (const f of frame == null ? [] : [].concat(frame)) base = base.frameLocator(f);
    if (within) base = this.locator(frame != null && typeof within === 'object' && within.frame == null ? {...within, frame} : within);
    // `nth` picks one of several elements with the same role and name, so match that name exactly.
    // Numbers in a name (article counts, prices, dates) change between visits, so any number matches.
    const pattern = n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+').replace(/\d[\d.,]*/g, '\\d[\\d.,]*');
    const named = name == null ? {} : exact || typeof name !== 'string' ? {name, exact: !!exact}
      : nth != null ? {name: new RegExp(`^\\s*${pattern(name)}\\s*$`, 'i')}
      : /\d/.test(name) ? {name: new RegExp(pattern(name), 'i')} : {name};
    let loc = role ? base.getByRole(role, hidden ? {...named, includeHidden: true} : named)
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
    // A name with a count or note after the words ("Issues 5k+ (5k+)", "Inbox (3)") may be read differently
    // on another visit; the words before it ("Issues") also find the element, though a full match is preferred.
    const words = typeof target === 'object' && target.role && typeof target.name === 'string' && !target.exact && target.nth == null
      ? /^([^\d(\[]*[^\d(\[\s])\s*[\d(\[]/.exec(target.name)?.[1] : null;
    const full = loc;
    if (words && words.length >= 3) {
      const escaped = words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      loc = full.or(this.locator({...target, name: new RegExp(`^\\s*${escaped}\\b`, 'i')}));
    }
    // Wait for any visible match, not just the first: pages often have a hidden copy too (a mobile menu).
    const visible = l => target?.nth != null ? l.first() : l.filter({visible: true}).first();
    // A link is also found by where it goes, in case its name has changed.
    // (By the start of the address up to any "?", since links may carry tracking codes that change.)
    const base = typeof target === 'object' && target.href ? target.href.split('?')[0] : '';
    const byHref = typeof target === 'object' && target.href && target.role
      ? this.locator({css: base.length > 1 ? `a[href^=${JSON.stringify(base)}]` : `a[href=${JSON.stringify(target.href)}]`, frame: target.frame}) : null;
    // Some sites leave an open menu marked hidden from screen readers (aria-hidden), which hides it from a
    // search by role and name even though it's on screen.
    const marked = typeof target === 'object' && target.role && target.nth == null ? this.locator(target, {hidden: true}) : null;
    let any = loc;
    for (const extra of [byHref, marked]) if (extra) any = any.or(extra);
    await this.waitVisible(visible(any), target, timeout);
    if (loc !== full && await visible(full).isVisible().catch(() => false)) loc = full;
    // A role name matches as a substring ("Code" also matches "Codespaces"), so an exact name wins.
    if (typeof target === 'object' && target.role && typeof target.name === 'string' && !target.exact && target.nth == null) {
      const exact = this.locator({...target, exact: true});
      if (await visible(exact).isVisible().catch(() => false)) loc = exact;
    }
    if (!await visible(loc).isVisible().catch(() => false)) {
      if (byHref && await visible(byHref).isVisible().catch(() => false)) {
        log(`   found it by where it goes (${target.href}); its name has changed`);
        loc = byHref;
      } else if (marked) loc = marked;
    }
    const count = await loc.count();
    if (count > 1 && target?.nth == null) {
      // Several matches: the visible one that goes to the recorded address, else the first visible one.
      let first = null, same = null;
      for (let i = 0; i < count && !same; i++) {
        const m = loc.nth(i);
        if (!await m.isVisible().catch(() => false)) continue;
        first ??= m;
        if (byHref && await m.evaluate((el, want) => {
          const href = el.closest('a')?.getAttribute('href');
          if (!href) return false;
          // The same address, ignoring tracking codes and the part after "#"; or at least the same page.
          const norm = h => {
            try {
              const u = new URL(h, location.href);
              for (const k of [...u.searchParams.keys()])
                if (/^(utm_|_ga$|_gl$|gclid$|fbclid$|msclkid$|mc_|_hs|amp(DeviceId|SessionId)$|_ics$|irclickid$|ref_?src$|icid$)/i.test(k)) u.searchParams.delete(k);
              return {full: u.origin + u.pathname + u.search, page: u.origin + u.pathname};
            } catch { return {full: h, page: h}; }
          };
          const a = norm(href), b = norm(want);
          return a.full === b.full || a.page === b.page;
        }, target.href).catch(() => false)) same = m;
      }
      loc = same ?? first ?? loc.first();
    } else loc = loc.first();
    await this.bringIntoView(loc);
    const box = await this.trueBox(loc);
    if (!box) throw new Error('Element has no box (hidden or detached)');
    return {loc, box};
  }

  // Wait for a target to be visible. If it's on the page but hidden in a closed menu (one that opens when you
  // point at or click a nav item), open that menu the way a person would, then carry on.
  async waitVisible(first, target, timeout) {
    const quick = Math.min(timeout, 1500);
    try { return await first.waitFor({state: 'visible', timeout: quick}); } catch (error) { if (timeout <= quick) throw error; }
    const started = Date.now();
    if (await this.openMenuFor(target)) {
      try { return await first.waitFor({state: 'visible', timeout: 2500}); } catch {}
    }
    try {
      await first.waitFor({state: 'visible', timeout: Math.max(1000, timeout - quick - (Date.now() - started))});
    } catch (error) {
      // Report the step's whole timeout, not just this last part of it.
      error.message = error.message.replace(/Timeout \d+ms/, `Timeout ${timeout}ms`);
      throw error;
    }
  }

  async openMenuFor(target) {
    if (typeof target !== 'object') return false;
    // Sites often have the same link twice (a desktop and a mobile menu), so look at each hidden match and
    // use the one whose menu is closest to the item that opens it.
    const matches = (await this.locator(target, {hidden: true}).elementHandles().catch(() => [])).slice(0, 8);
    let best = null;
    for (const match of matches) {
      const found = await match.evaluateHandle(el => {
        const shown = n => {
          const s = getComputedStyle(n), r = n.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05;
        };
        const closed = n => !shown(n) || n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('inert');
        const up = n => n.parentElement ?? (n.parentNode instanceof ShadowRoot ? n.parentNode.host : null);
        const OPENER = 'a[href],button,[role=button],[role=menuitem],[role=tab],[aria-haspopup],[aria-expanded]';
        // The closed menu: the outermost closed box around the target.
        let menu = null;
        for (let n = el; n && n !== document.body; n = up(n)) if (closed(n)) menu = n;
        if (!menu) return null;
        const usable = c => shown(c) && !closed(c) && !menu.contains(c) && !c.contains(menu);
        let opener = null, level = 0;
        // Something that says it controls the menu (or a box inside it).
        for (let n = el; n && n !== up(menu) && !opener; n = up(n))
          if (n.id) {
            const c = document.querySelector(`[aria-controls~="${CSS.escape(n.id)}"]`);
            if (c && usable(c)) opener = c;
          }
        // The usual layout: the nav item sits just before its menu, in the same wrapper (a list item, say).
        for (let w = up(menu); !opener && w && w !== document.body && level < 3; w = up(w), level++) {
          const before = [...w.querySelectorAll(OPENER)].filter(c => usable(c) &&
            (c.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING));
          opener = before.findLast(c => c.matches('[aria-haspopup],[aria-expanded]')) ?? before.at(-1) ?? null;
        }
        if (!opener) return null;
        // Lower is better: near the menu, a drop-down box, an item that says it opens a menu.
        const dropDown = /^(absolute|fixed)$/.test(getComputedStyle(menu).position);
        const score = level * 4 + (dropDown ? 0 : 2) + (opener.matches('[aria-haspopup],[aria-expanded]') ? 0 : 1);
        return {opener, score};
      }).catch(() => null);
      const score = await found?.evaluate(f => f?.score ?? null).catch(() => null);
      if (score != null && (!best || score < best.score)) {
        await best?.found.dispose();
        best = {found, score};
      } else await found?.dispose();
    }
    for (const match of matches) await match.dispose();
    const trigger = best ? await best.found.evaluateHandle(f => f.opener) : null;
    await best?.found.dispose();
    const opener = trigger?.asElement();
    if (!opener) return false;
    const box = await opener.boundingBox().catch(() => null);
    if (!box) return false;
    const name = await opener.evaluate(n => (n.getAttribute('aria-label') || n.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60)).catch(() => '');
    log(`   opening the menu${name ? ` “${name}”` : ''} first`);
    // Point at it: most menus open on hover.
    await this.glide(box.x + box.width / 2, box.y + box.height / 2);
    await this.wait(700);
    if (await this.locator(target, {hidden: true}).filter({visible: true}).first().isVisible().catch(() => false)) return true;
    // Some open on a click instead. Click only if that can't leave the page: a button, a menu toggle or
    // a link to "#".
    const toggles = await opener.evaluate(n => !n.matches('a[href]') || n.matches('[aria-haspopup],[aria-expanded]') ||
      /^(#|javascript:)/i.test(n.getAttribute('href') ?? '')).catch(() => false);
    if (!toggles) return false;
    await this.page.mouse.down(); await sleep(70); await this.page.mouse.up();
    await this.wait(600);
    return true;
  }

  // Playwright's boundingBox() is wrong for elements inside iframes when the page uses CSS zoom, so
  // compute the on-screen box ourselves: element rect in its frame, then map through each parent iframe.
  async trueBox(loc) {
    const h = await loc.elementHandle().catch(() => null);
    if (!h) return null;
    // A link that wraps onto two lines has a bounding box covering both lines, and its centre is often plain
    // text, not the link. So aim at one of the element's own line boxes: the first one whose centre really
    // is the element (hit-tested), else the largest one.
    let r = await h.evaluate(e => {
      const whole = e.getBoundingClientRect();
      const parts = [...e.getClientRects()].filter(b => b.width > 1 && b.height > 1);
      const at = (x, y) => {
        const t = e.ownerDocument.elementFromPoint(x, y);
        return !!t && (t === e || e.contains(t));
      };
      const hits = b => at(b.x + b.width / 2, b.y + b.height / 2);
      const byArea = [...(parts.length ? parts : [whole])].sort((a, b) => b.width * b.height - a.width * a.height);
      const b = byArea.find(hits);
      if (b) return {x: b.x, y: b.y, width: b.width, height: b.height};
      // The centre is covered by something else (a caption laid over a link, say): aim at a part that isn't.
      for (const box of byArea) {
        for (const [fx, fy] of [[0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75], [0.15, 0.3], [0.85, 0.7], [0.1, 0.5], [0.9, 0.5]]) {
          const x = box.x + box.width * fx, y = box.y + box.height * fy;
          if (at(x, y)) return {x: x - 2, y: y - 2, width: 4, height: 4};
        }
      }
      const c = byArea[0];
      return {x: c.x, y: c.y, width: c.width, height: c.height};
    });
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
    // Only clear a field that has text: extra keys in an empty field can upset autocomplete widgets.
    const hasText = await this.page.evaluate(() => {
      let el = document.activeElement;
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
      return !!(el && ('value' in el ? el.value : el.isContentEditable ? el.innerText.trim() : ''));
    }).catch(() => true);
    if (step.clear && hasText) {
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

  // waitForStable with `around`: wait for the answer to a question typed into the `around` field.
  // 1) Wait until something near that field changes (the reply starts), up to `changeMs`.
  // 2) Watch the smallest container of the field where that change happened (for example, the chat panel).
  // 3) Done when it has stopped changing for `quietMs` and shows no loading or typing indicator.
  // A site that never settles doesn't fail the run: the step ends at `maxMs` with a warning in the report.
  async waitAround(step, timeout) {
    const field = this.locator(step.around).last();
    await field.waitFor({state: 'attached', timeout});
    const checkFailure = async () => {
      if (step.requireChange === false) return;
      const expired = await field.evaluate(el => {
        let container = el.closest('form,[role="dialog"],[role="log"]') ?? el.parentElement;
        if (!container) return false;
        if (container === el.parentElement) {
          for (let i = 0; i < 4 && container.parentElement && container.parentElement !== document.body; i++)
            container = container.parentElement;
        }
        return [...container.querySelectorAll('*')].some(n =>
          n.children.length === 0 && /^session expired\.?\s*(?:please )?refresh (?:the |this )?page\.?$/i.test((n.innerText ?? '').trim()));
      });
      if (expired) throw new AssistantResponseError('Assistant reported an expired session; refresh and retry.');
    };
    await checkFailure();
    const sigs = () => field.evaluate(el => {
      const busyIn = c => {
        if (c.closest('[aria-busy="true"]')) return true;
        const q = c.querySelectorAll('[aria-busy="true"],[role=progressbar],[class*="typing" i],[class*="thinking" i],' +
          '[class*="spinner" i],[class*="loading" i]:not([class*="loaded" i]),[class*="ellipsis" i],[class*="skeleton" i]');
        for (const n of q) {
          const r = n.getBoundingClientRect(), cs = getComputedStyle(n);
          if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0) return true;
        }
        return false;
      };
      const chain = [];
      for (let n = el.parentElement ?? el.getRootNode()?.host; n; n = n.parentElement ?? n.getRootNode?.()?.host) {
        chain.push(n);
        if (n === document.body) break;
      }
      chain.reverse(); // outermost (body) first
      return chain.map(c => {
        const len = (c.innerText ?? '').length, count = c.querySelectorAll('*').length;
        return {sig: `${len}:${count}`, len, count, busy: busyIn(c)};
      });
    });
    const textAt = depth => field.evaluate((el, depth) => {
      const chain = [];
      for (let n = el.parentElement ?? el.getRootNode()?.host; n; n = n.parentElement ?? n.getRootNode?.()?.host) {
        chain.push(n); if (n === document.body) break;
      }
      chain.reverse();
      const t = (chain[Math.min(depth, chain.length - 1)]?.innerText ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      return t.length > 4000 ? '…' + t.slice(-4000) : t;
    }, depth).catch(() => '');
    const quiet = step.quietMs ?? 2000, changeMs = step.changeMs ?? 20000, limit = step.maxMs ?? 90000;
    const t0 = performance.now();
    const base = await sigs();
    // The reply is the deepest container of the field that has *grown* since the step started (new text or
    // new elements). Small changes next to the field, such as a Send button turning into Stop, don't count.
    // Changes that only show up at the page level (carousels, banners) are ignored for the first 5 s, so
    // they aren't mistaken for the reply.
    const deepestChange = now => {
      if (!now) return -1;
      if (now.length !== base.length) return Math.max(0, Math.min(now.length, base.length) - 1); // re-rendered
      for (let i = now.length - 1; i >= 0; i--) if (now[i].len - base[i].len >= 15 || now[i].count - base[i].count >= 3) return i;
      return now[0] && now[0].sig !== base[0].sig ? 0 : -1;
    };
    let depth = -1;
    // 1) Wait for the reply to start.
    while (depth < 0) {
      await sleep(150);
      await checkFailure();
      const d = deepestChange(await sigs().catch(() => null));
      if (d >= 1 || (d === 0 && performance.now() - t0 > 5000)) depth = d;
      if (depth < 0 && performance.now() - t0 > changeMs) {
        this.lastWait = {warning: `nothing changed near the field within ${changeMs} ms`, waitedMs: Math.round(performance.now() - t0)};
        log(`  warning: waitForStable: ${this.lastWait.warning}; continuing`);
        return;
      }
    }
    // 2-3) Wait for it to settle.
    let last = '', since = performance.now(), busySeen = false;
    for (;;) {
      await checkFailure();
      const now = await sigs().catch(() => null);
      const d = deepestChange(now);
      if (d > depth) { depth = d; last = ''; } // the reply showed up deeper than the first change: follow it
      const c = now?.[Math.min(depth, (now?.length ?? 1) - 1)];
      const sig = c ? c.sig : '';
      if (c?.busy) busySeen = true;
      if (sig !== last || c?.busy) { last = sig; since = performance.now(); }
      else if (performance.now() - since >= quiet && performance.now() - t0 >= (step.minMs ?? 0)) break;
      if (performance.now() - t0 > limit) {
        this.lastWait = {warning: `still changing after ${limit} ms`, waitedMs: Math.round(performance.now() - t0)};
        log(`  warning: waitForStable: ${this.lastWait.warning}; continuing`);
        this.lastWait.watched = await textAt(depth);
        return;
      }
      await sleep(150);
    }
    this.lastWait = {waitedMs: Math.round(performance.now() - t0), busySeen, watched: await textAt(depth)};
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
        // Labels are easy to read and edit; the recorded value still works when a label changes (such as a date).
        if (step.label != null) {
          try { await loc.selectOption({label: step.label}, {timeout: step.value != null ? 1500 : timeout}); break; }
          catch (error) { if (step.value == null) throw error; }
        }
        await loc.selectOption({value: step.value});
        break;
      }
      case 'check': case 'uncheck': {
        const {loc} = await this.acquire(step.target, timeout);
        if ((await loc.isChecked()) !== (step.action === 'check')) await this.click(step, timeout);
        break;
      }
      case 'wait': await p.waitForTimeout(step.ms ?? 1000); break;
      case 'waitFor':
        if (step.target) {
          const all = this.locator(step.target);
          await ((step.state ?? 'visible') === 'visible' ? all.filter({visible: true}) : all).first().waitFor({state: step.state ?? 'visible', timeout});
        }
        else if (step.url) await p.waitForURL(step.url, {timeout});
        else await p.waitForLoadState(step.state ?? 'networkidle', {timeout});
        break;
      case 'waitForStable': {
        if (step.around) { await this.waitAround(step, timeout); break; }
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
      case 'caption': await p.evaluate(t => {
        if (!window.__demoOverlay) throw new Error('Replay overlay is unavailable.');
        window.__demoOverlay.caption(t);
      }, step.text ?? null); break;
      case 'highlight': {
        const {box} = await this.acquire(step.target, timeout);
        const ms = step.ms ?? 1400;
        await p.evaluate(([b, ms]) => {
          if (!window.__demoOverlay) throw new Error('Replay overlay is unavailable.');
          window.__demoOverlay.highlight(b, ms);
        }, [box, ms]);
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

  // After anything that might navigate: let the new page settle and put the cursor back. A click that opens
  // a new page starts loading a moment later, so look for that first; otherwise the next step would act on
  // the old page while it's being replaced. `since`: when the step began.
  async settle(since = Date.now()) {
    for (let i = 0; i < 6 && this.navStarted < since; i++) await sleep(100);
    if (this.navStarted >= since) {
      const deadline = Date.now() + 15000;
      while (this.navCommitted < this.navStarted && Date.now() < deadline) await sleep(100);
    }
    try { await this.page.waitForLoadState('load', {timeout: 15000}); } catch {}
    // Let web fonts finish, but not forever: on some pages a font never finishes loading.
    try { await this.page.evaluate(() => Promise.race([document.fonts?.ready, new Promise(r => setTimeout(r, 3000))])); } catch {}
    try { await this.page.mouse.move(this.mouse.x, this.mouse.y); } catch {}
  }
}

// ------------------------------------------------------------------------------------------
// Main
// ------------------------------------------------------------------------------------------
function log(...a) { console.error('[stand-in]', ...a); }
function die(msg) { console.error(`[stand-in] ERROR: ${msg}`); process.exit(1); }

// ------------------------------------------------------------------------------------------
// Plain-language messages
// ------------------------------------------------------------------------------------------
const short = (s, n = 50) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function describeTarget(t) {
  if (t == null) return 'the page';
  if (typeof t === 'string') return `the element ${short(t)}`;
  const inFrame = t.frame != null ? ' (inside a frame)' : '';
  const which = t.nth ? ` (match ${t.nth + 1})` : '';
  if (t.role && t.name != null) return `the ${t.role} “${short(t.name)}”${which}${inFrame}`;
  if (t.label != null) return `the “${short(t.label)}” field${inFrame}`;
  if (t.placeholder != null) return `the “${short(t.placeholder)}” field${inFrame}`;
  if (t.text != null) return `the text “${short(t.text)}”${inFrame}`;
  if (t.testId != null) return `the element with test id “${t.testId}”${which}${inFrame}`;
  if (t.role) return `a ${t.role}${inFrame}`;
  return `the element ${short(t.css ?? JSON.stringify(t), 60)}${inFrame}`;
}
function describeStep(step) {
  const t = describeTarget(step.target);
  switch (step.action) {
    case 'click': return `${step.double ? 'double-click' : step.button === 'right' ? 'right-click' : 'click'} ${t}`;
    case 'type': return `type “${short(step.text, 30)}” into ${step.target ? t : 'the focused field'}${step.submit ? ' and press Enter' : ''}`;
    case 'press': return `press ${step.key}`;
    case 'hover': return `point at ${t}`;
    case 'scroll': return step.to ? `scroll to ${describeTarget(step.to)}` : `scroll ${step.target ? t : 'the page'}`;
    case 'select': return `choose “${short(step.label ?? step.value)}” in ${t}`;
    case 'check': case 'uncheck': return `${step.action} ${t}`;
    case 'drag': return `drag ${t}`;
    case 'wait': return `wait ${((step.ms ?? 1000) / 1000).toFixed(1)} s`;
    case 'waitFor': return step.target ? `wait for ${t}` : step.url ? `wait for ${step.url}` : 'wait for the page to load';
    case 'waitForStable': return step.around ? `wait for the answer near ${describeTarget(step.around)}` : `wait for ${t} to stop changing`;
    case 'caption': return step.text ? `show caption “${short(step.text, 40)}”` : 'hide the caption';
    case 'highlight': return `highlight ${t}`;
    case 'goto': return `go to ${step.url}`;
    case 'move': return 'move the pointer';
    default: return step.action;
  }
}
// Playwright errors are long and technical; keep the part a person can act on.
function explainError(error, step) {
  const msg = String(error?.message ?? error);
  if (error?.name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(msg)) {
    const secs = Math.round((step?.timeout ?? 10000) / 1000);
    if (/waitForURL/.test(msg)) return `The page didn't reach ${step.url} within ${secs} seconds.`;
    if (/waitForLoadState/.test(msg)) return `The page didn't finish loading within ${secs} seconds.`;
    if (step && (step.target || step.around || step.to)) return `Couldn't find ${describeTarget(step.target ?? step.around ?? step.to)} on the page within ${secs} seconds.`;
    return `Timed out after ${secs} seconds.`;
  }
  if (/intercepts pointer events|not visible|outside of the viewport/.test(msg)) return 'Something on the page was covering it.';
  return msg.split('\n')[0].replace(/^(?:locator|page|frame|elementHandle)\.\w+: /, '');
}
const NET_ERRORS = {
  ERR_NAME_NOT_RESOLVED: 'the address could not be found. Check the spelling.',
  ERR_INTERNET_DISCONNECTED: 'this computer is offline.',
  ERR_CONNECTION_REFUSED: 'the site refused the connection.',
  ERR_CONNECTION_TIMED_OUT: 'the site did not respond.',
  ERR_CERT_COMMON_NAME_INVALID: 'the site\'s security certificate is not valid.',
  ERR_CERT_AUTHORITY_INVALID: 'the site\'s security certificate is not trusted.',
  ERR_TUNNEL_CONNECTION_FAILED: 'the network proxy could not reach it. Check the address and your connection.',
  ERR_PROXY_CONNECTION_FAILED: 'the network proxy is not responding.',
  ERR_CONNECTION_RESET: 'the connection was cut off. Try again. If it keeps happening, the site may refuse browsers controlled by software, as some do.',
  ERR_CONNECTION_CLOSED: 'the site closed the connection. Try again. If it keeps happening, the site may refuse browsers controlled by software, as some do.',
  ERR_HTTP2_PROTOCOL_ERROR: 'the connection to the site broke off. Try again. If it keeps happening, the site may refuse browsers controlled by software, as some do.',
  ERR_EMPTY_RESPONSE: 'the site sent nothing back. Try again later.',
  ERR_HTTP_RESPONSE_CODE_FAILURE: 'the site answered with an error page. Try again later.',
  ERR_TIMED_OUT: 'the site did not respond.',
  ERR_TOO_MANY_REDIRECTS: 'the site kept sending Chrome to another address. Try opening it in your usual browser first.',
  ERR_SSL_PROTOCOL_ERROR: 'a secure connection to the site couldn\'t be made.',
};
function explainNavigation(error, url) {
  const code = /net::(ERR_[A-Z0-9_]+)/.exec(error?.message ?? '')?.[1];
  if (code) return `Couldn't open ${url}: ${NET_ERRORS[code] ?? `Chrome reported ${code}.`}`;
  return `Couldn't open ${url}: ${explainError(error)}`;
}
// Paths inside the current folder are shown relative to it, which is shorter and easier to find.
function shown(path) {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith('..') && !/^[a-z]:/i.test(rel) ? rel : path;
}

// ------------------------------------------------------------------------------------------
// File names: "wikipedia.org-2026-11-21-14-05.mp4" in local time; "-2", "-3" when taken.
// ------------------------------------------------------------------------------------------
function localStamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}`;
}
function siteName(url) {
  return url.hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]+/gi, '-') || 'website';
}
// The first name that is free in every one of `files` (functions from a base name to a path).
function freeName(base, ...files) {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (files.every(f => !existsSync(f(name)))) return name;
  }
}

// ------------------------------------------------------------------------------------------
// Chrome records AV1, which QuickTime on Intel Macs, older Windows players and many editors can't play.
// Re-encode to H.264 with Chrome's own WebCodecs encoder (hardware where available) and the mediabunny
// MP4 library, in a hidden Chrome. No ffmpeg needed. If it can't, the AV1 file is kept.
// ------------------------------------------------------------------------------------------
async function makePlayable({chromium, chromePath, file, trim = false}) {
  // Only this one browser build of mediabunny ships with the extension, so find the file directly.
  const bundle = createRequire(import.meta.url).resolve.paths('mediabunny')
    .map(dir => join(dir, 'mediabunny', 'dist', 'bundles', 'mediabunny.min.mjs')).find(existsSync);
  if (!bundle) return {ok: false, reason: 'the mediabunny package is missing; reinstall Stand-in'};
  const ORIGIN = 'https://stand-in.invalid';
  const tty = process.stderr.isTTY;
  const temporary = file.replace(/\.mp4$/i, '') + '.converting.mp4';
  let browser, input, output, written = 0, lastShown = 0;
  const progress = p => {
    const pct = Math.floor(p * 100);
    if (tty) process.stderr.write(`\r[stand-in] Finishing the video… ${pct}%`);
    else if (!lastShown) { lastShown = 1; log('Finishing the video…'); }
  };
  interruption.converting = {file, temporary};
  try {
    input = await open(file, 'r');
    output = await open(temporary, 'w');
    const size = (await input.stat()).size;
    browser = await chromium.launch({executablePath: chromePath, headless: true,
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false});
    const page = await browser.newPage();
    // The page reads the recording and writes the result in pieces: long videos are too big to pass at once.
    await page.route(ORIGIN + '/**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === '/') return route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Stand-in</title><link rel="icon" href="data:,">'});
      if (url.pathname === '/mediabunny.mjs') return route.fulfill({contentType: 'text/javascript', body: await readFile(bundle)});
      if (url.pathname === '/read') {
        const start = +url.searchParams.get('start'), length = Math.max(0, Math.min(+url.searchParams.get('end'), size) - start);
        const {buffer} = await input.read({buffer: Buffer.alloc(length), position: start, length});
        return route.fulfill({contentType: 'application/octet-stream', body: buffer});
      }
      if (url.pathname === '/write') {
        const data = request.postDataBuffer();
        await output.write(data, 0, data.length, +url.searchParams.get('at'));
        written += data.length;
        return route.fulfill({body: 'ok'});
      }
      return route.fulfill({status: 404});
    });
    await page.goto(ORIGIN + '/');
    await page.exposeFunction('__standInProgress', progress);
    const result = await page.evaluate(async ({size, trim, pauseMs}) => {
      const mb = await import('/mediabunny.mjs');
      const PIECE = 8 << 20;
      const read = async (start, end) => {
        const out = new Uint8Array(end - start);
        for (let at = start; at < end; at += PIECE) {
          const part = await fetch(`/read?start=${at}&end=${Math.min(end, at + PIECE)}`);
          out.set(new Uint8Array(await part.arrayBuffer()), at - start);
        }
        return out;
      };
      const input = new mb.Input({source: new mb.CustomSource({getSize: () => size, read}), formats: mb.ALL_FORMATS});
      const video = await input.getPrimaryVideoTrack(), audio = await input.getPrimaryAudioTrack();
      if (!video) return {error: 'the recording has no video'};
      const width = video.displayWidth, height = video.displayHeight, fps = 60;
      // About Chrome's own recording bitrate: plenty for crisp text and smooth scrolling.
      const bitrate = Math.round(Math.min(20e6, Math.max(4e6, width * height * fps * 0.07)));
      // H.264 High profile at a level that allows this size at 60 fps (players check it; 1080p60 needs 4.2).
      const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
      const level = [[30, 40500, 1620], [31, 108000, 3600], [32, 216000, 5120], [40, 245760, 8192], [42, 522240, 8704],
        [50, 589824, 22080], [51, 983040, 36864], [52, 2073600, 36864]].find(([, rate, size]) => mbs <= size && mbs * fps <= rate)?.[0] ?? 52;
      const codec = `avc1.6400${level.toString(16).padStart(2, '0')}`;
      const supported = await VideoEncoder.isConfigSupported({codec, width, height, bitrate, framerate: fps}).catch(() => ({}));
      if (!supported.supported) return {error: 'this Chrome cannot encode H.264 video'};
      if (audio && !(await mb.canEncodeAudio('aac'))) return {error: 'this Chrome cannot convert the recorded sound'};
      const target = new mb.StreamTarget(new WritableStream({
        async write(chunk) {
          const response = await fetch(`/write?at=${chunk.position}`, {method: 'POST', body: chunk.data});
          if (!response.ok) throw new Error('could not save the converted video');
        },
      }), {chunked: true, chunkSize: PIECE});
      const output = new mb.Output({format: new mb.Mp4OutputFormat({fastStart: false}), target});
      // Tell the encoder the frame rate (it picks the H.264 level from it) without snapping timestamps to 1/60 s.
      const videoOut = new mb.VideoSampleSource({codec: 'avc', fullCodecString: codec, bitrate, keyFrameInterval: 2,
        onEncoderConfig: config => { config.framerate = fps; }});
      // No fixed frame rate: Chrome's frames come at uneven times, and rounding them to 1/60 s would collide.
      output.addVideoTrack(videoOut);
      const audioOut = audio && new mb.AudioSampleSource({codec: 'aac', bitrate: 160e3});
      if (audioOut) output.addAudioTrack(audioOut);
      await output.start();
      const end = (await video.computeDuration()) || 1;
      // Pauses: while the screen doesn't change, nothing new is shown, so those frames are merged into one
      // that stays up for at most LEAD seconds at the start, PAUSE in the middle and TAIL at the end. The
      // cursor moving, a page loading or an answer streaming in all count as changes and are kept.
      // (Not with sound, which would fall out of step.)
      const LEAD = 0.5, PAUSE = pauseMs / 1000, TAIL = 1.5;
      const shorten = trim && !audio;
      const thumb = new OffscreenCanvas(192, 108).getContext('2d', {willReadFrequently: true});
      let shownThumb = null;
      const changed = sample => {
        sample.draw(thumb, 0, 0, 192, 108);
        const px = thumb.getImageData(0, 0, 192, 108).data;
        let n = 0;
        if (shownThumb) {
          for (let i = 0; i < px.length && n < 3; i += 4)
            if (Math.abs(px[i] - shownThumb[i]) > 32 || Math.abs(px[i + 1] - shownThumb[i + 1]) > 32 || Math.abs(px[i + 2] - shownThumb[i + 2]) > 32) n++;
        }
        // A blinking text cursor changes a pixel or two; that alone is not a change.
        if (!shownThumb || n >= 3) { shownThumb = px; return true; }
        return false;
      };
      let removed = 0;
      const copyVideo = async () => {
        let shown = 0, held = null, heldAt = 0, heldFirst = false, offset = 0;
        for await (const sample of new mb.VideoSampleSink(video).samples()) {
          const t = sample.timestamp;
          if (t / end - shown >= 0.01) { shown = t / end; window.__standInProgress(Math.min(0.99, shown)); }
          if (!shorten) { await videoOut.add(sample); sample.close(); continue; }
          if (held && !changed(sample)) { sample.close(); continue; }
          if (!held) changed(sample);
          else {
            // The held frame stayed up from heldAt until now; keep at most LEAD or PAUSE seconds of that.
            const still = t - heldAt, keep = heldFirst ? LEAD : PAUSE;
            if (still > keep) offset += still - keep;
            held.setDuration(t - offset - held.timestamp);
            await videoOut.add(held);
            held.close();
          }
          sample.setTimestamp(t - offset);
          heldFirst = !held;
          held = sample; heldAt = t;
        }
        if (held) {
          const still = end - heldAt;
          held.setDuration(Math.max(1 / 60, Math.min(still, TAIL)));
          offset += Math.max(0, still - TAIL);
          await videoOut.add(held);
          held.close();
        }
        removed = offset;
        videoOut.close();
      };
      const copyAudio = async () => {
        for await (const sample of new mb.AudioSampleSink(audio).samples()) { await audioOut.add(sample); sample.close(); }
        audioOut.close();
      };
      await Promise.all([copyVideo(), audioOut && copyAudio()]);
      await output.finalize();
      window.__standInProgress(1);
      return {ok: true, duration: end, removed};
    }, {size, trim, pauseMs: PAUSE_MS});
    if (tty) process.stderr.write('\n');
    if (!result.ok || !written) return {ok: false, reason: result.error ?? 'the converted video was empty'};
    await output.close(); output = null;
    await input.close(); input = null;
    await rename(temporary, file);
    return {ok: true, duration: result.duration, removed: result.removed};
  } catch (error) {
    if (tty) process.stderr.write('\n');
    return {ok: false, reason: explainError(error)};
  } finally {
    interruption.converting = null;
    await browser?.close().catch(() => {});
    await input?.close().catch(() => {});
    if (output) { await output.close().catch(() => {}); await rm(temporary, {force: true}).catch(() => {}); }
  }
}
// Returns a note about the video's length for the final message.
async function finishVideo({chromium, chromePath, file, convert, trim}) {
  if (!convert) return '';
  const t0 = Date.now();
  const result = await makePlayable({chromium, chromePath, file, trim});
  if (!result.ok) {
    log(`Kept the original AV1 video (${result.reason}). It plays in Chrome, Edge, VLC and recent Macs;` +
      ' older players such as QuickTime on Intel Macs may not open it.');
    return '';
  }
  if (process.env.STAND_IN_DEBUG) log(`Converted to H.264 in ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
  return result.removed >= 1 ? ` (${clock(result.duration - result.removed)}; pauses shortened from ${clock(result.duration)})`
    : ` (${clock(result.duration)})`;
}
// ------------------------------------------------------------------------------------------
// Recording straight to disk. Chrome writes the recording as a fragmented MP4 while it records, and
// Stand-in copies it into the video file every quarter second. Whatever happens (the tab or Chrome is
// closed, the tab crashes, Ctrl+C), the video up to that moment is already in the file.
// ------------------------------------------------------------------------------------------
async function recordToFile(page, {file, frameRate, maxWidth, maxHeight, audio}) {
  await mkdir(dirname(file), {recursive: true});
  const out = await open(file, 'wx');
  let session, stream;
  try {
    session = await page.context().newCDPSession(page);
    ({stream} = await session.send('Page.startScreenRecording', {frameRate, maxWidth, maxHeight, audio}));
  } catch (error) {
    await out.close().catch(() => {});
    await rm(file, {force: true}).catch(() => {});
    await session?.detach().catch(() => {});
    throw error;
  }
  const startedAt = Date.now();
  let stopping = false, closed = false, lost = null, bytes = 0;
  const read = async () => {
    const chunk = await session.send('IO.read', {handle: stream, size: 4 << 20});
    const data = Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
    if (data.length && !closed) { await out.write(data); bytes += data.length; }
    return {data, eof: chunk.eof};
  };
  // "eof" while recording only means "nothing new yet"; Chrome adds a piece every few seconds, and a read
  // before the first piece fails. Only a closed tab or browser ends the copying early.
  const gone = error => /has been closed|detached|crashed|No target with given id|Target closed/i.test(error.message);
  const copying = (async () => {
    while (!stopping) {
      try { if (!(await read()).data.length) await sleep(250); }
      catch (error) {
        if (gone(error)) { lost = error; if (process.env.STAND_IN_DEBUG) log(`Recording copy stopped: ${error.message}`); return; }
        await sleep(250);
      }
    }
  })();
  let finished;
  return {
    file, startedAt,
    // `abandon`: the tab is gone or not answering, so keep what is already saved instead of asking Chrome.
    stop({abandon = false} = {}) {
      finished ??= (async () => {
        stopping = true;
        await copying;
        if (!abandon && !lost) {
          // Chrome usually finishes within a few seconds; a tab that stopped answering must not hang Stand-in.
          let giveUp, timedOut = false;
          const finishing = (async () => {
            await session.send('Page.stopScreenRecording');
            // Read until Chrome says the file is complete, then once more in case a last piece follows.
            for (let quiet = 0, failures = 0; quiet < 2 && !timedOut;) {
              let chunk;
              try { chunk = await read(); failures = 0; }
              catch (error) { if (gone(error) || ++failures > 40) throw error; await sleep(250); continue; }
              if (chunk.eof && !chunk.data.length) { quiet++; if (quiet < 2) await sleep(150); } else quiet = 0;
            }
            await session.send('IO.close', {handle: stream}).catch(() => {});
          })();
          finishing.catch(() => {});
          const limit = new Promise((_, reject) => {
            giveUp = setTimeout(() => { timedOut = true; reject(new Error('Chrome did not finish the video in time')); }, 60000);
          });
          try { await Promise.race([limit, finishing]); }
          catch (error) { lost = error; }
          finally { clearTimeout(giveUp); }
          // Let a read already under way finish before the file closes.
          if (timedOut) await Promise.race([finishing.catch(() => {}), sleep(2000)]);
        }
        await session.detach().catch(() => {});
        closed = true;
        await out.close();
        const complete = !abandon && !lost;
        // A recording cut off mid-piece ends with a partial piece; drop it so the file plays.
        const size = complete ? bytes : await keepWholeFragments(file);
        if (!size) await rm(file, {force: true}).catch(() => {});
        return {file, size, complete, seconds: (Date.now() - startedAt) / 1000};
      })();
      return finished;
    },
  };
}

// Truncates a fragmented MP4 after its last complete media fragment. Returns the new size (0 if no video).
async function keepWholeFragments(file) {
  const fh = await open(file, 'r+');
  try {
    const {size} = await fh.stat();
    const header = Buffer.alloc(16);
    let at = 0, keep = 0, sawMoof = false;
    while (at + 8 <= size) {
      await fh.read(header, 0, 16, at);
      let length = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (length === 1) length = Number(header.readBigUInt64BE(8));
      else if (length === 0) length = size - at;
      if (length < 8 || at + length > size) break;
      if (type === 'moof') sawMoof = true;
      if (type === 'mdat' && sawMoof) keep = at + length;
      at += length;
    }
    await fh.truncate(keep);
    return keep;
  } finally { await fh.close(); }
}

const clock = seconds => { const t = Math.round(seconds); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

// Ctrl+C, VS Code's "Terminate Task" and closing the terminal all come here. While a video is being made,
// the current phase decides (stop and save); otherwise Chrome is closed and Stand-in exits. Pressing
// Ctrl+C again always exits at once; anything already recorded is in the video file.
const interruption = {handler: null, cleanup: async () => {}, count: 0, converting: null};
const REASONS = {SIGINT: 'Stopped with Ctrl+C.', SIGTERM: 'Stand-in was asked to stop.', SIGHUP: 'The terminal was closed.'};
function interrupted(signal) {
  const exit = () => process.exit(signal === 'SIGINT' ? 130 : 143);
  if (++interruption.count > 1 || !interruption.handler) {
    if (process.stderr.isTTY) process.stderr.write('\n');
    if (interruption.converting) {
      rmSync(interruption.converting.temporary, {force: true});
      log(`Stopped before the video was finished. The original recording is kept: ${shown(interruption.converting.file)}`);
    } else if (interruption.count === 1) log('Stopping…');
    Promise.race([interruption.cleanup(), sleep(5000)]).catch(() => {}).finally(exit);
    return;
  }
  interruption.handler(REASONS[signal]);
}
function listenForInterruptions(cleanup) {
  interruption.cleanup = cleanup;
  for (const signal of Object.keys(REASONS)) process.on(signal, () => interrupted(signal));
}

// Lets the VS Code extension show "your video is ready" when the terminal task ends.
async function writeResult(result) {
  const file = process.env.STAND_IN_RESULT;
  if (!file) return;
  try { await writeFile(file, JSON.stringify(result)); } catch {}
}
async function loadPlan(file) {
  const abs = resolve(file);
  let raw;
  try { raw = JSON.parse(await readFile(abs, 'utf8')); } catch (e) { die(`Cannot read plan ${abs}: ${e.message}`); }
  if (typeof raw.profileDir === 'string') raw.profileDir = resolve(dirname(abs), raw.profileDir.replace(/^~(?=\/)/, homedir()));
  if (typeof raw.url === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(raw.url))
    raw.url = pathToFileURL(resolve(dirname(abs), raw.url)).href;
  return raw;
}

function normalisePlan(raw, urlOverride) {
  const plan = {
    viewport: {width: 1920, height: 1080}, zoom: 1, fps: 60, audio: false, cursor: true, pace: 'normal',
    leadInMs: 800, tailMs: 1500, timeout: 10000, steps: [], ...raw,
  };
  if (urlOverride) plan.url = urlOverride;
  if (!plan.url) die('Plan has no "url".');
  if (!Array.isArray(plan.steps)) die('Plan "steps" must be an array.');
  plan.viewport = {width: 1920, height: 1080, ...plan.viewport};
  plan.overlay = {cursor: plan.cursor !== false, keepAlive: plan.constantFrameRate !== false, accent: plan.accent ?? '#f5b400', cursorColor: '#ffffff', cursorStroke: '#111111',
    captionSize: Math.round(plan.viewport.height / 1080 * 34), ...(plan.overlay ?? {})};
  return plan;
}

// Node 22 is what VS Code itself has run on since early 2026, so the extension can use VS Code's own.
const MIN_NODE = 22;
function requireSupportedNode(version) {
  const [major] = version.split('.').map(Number);
  if (major < MIN_NODE)
    throw new UserError(`Stand-in needs Node.js ${MIN_NODE} or newer (found ${version}). Install it from https://nodejs.org, then try again.`,
      {link: 'https://nodejs.org/en/download'});
}

// Replays use the saved browser session, so they can act as the person on signed-in sites. A plan they
// recorded themselves is trusted; one that is new to this session or has changed since (edited, or from
// someone else) is shown to them once. Approvals are kept next to the session, by the plan's contents.
const planDigest = text => createHash('sha256').update(text).digest('hex');
function approvalsFile(profileDir) { return join(dirname(profileDir), 'approved-plans.json'); }
async function readApprovals(profileDir) {
  try { return JSON.parse(await readFile(approvalsFile(profileDir), 'utf8')); } catch { return {}; }
}
async function approvePlan(profileDir, text) {
  const approvals = await readApprovals(profileDir);
  approvals[planDigest(text)] = new Date().toISOString();
  await mkdir(dirname(approvalsFile(profileDir)), {recursive: true});
  await writeFile(approvalsFile(profileDir), JSON.stringify(approvals, null, 2) + '\n');
}
async function confirmSignedInReplay(plan, planText, approved) {
  if (!(plan.signedIn || plan.profileDir)) return;
  if (plan.profileDir && (await readApprovals(plan.profileDir))[planDigest(planText)]) return;
  if (!approved) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new UserError('This plan is new or has changed since it was recorded, and replays can act as you on signed-in sites.\n' +
        '  Review it for actions that change real data, then rerun with --confirm-signed-in (explicit approval).');
    const prompt = createInterface({input: process.stdin, output: process.stdout});
    try {
      const answer = await prompt.question('This plan is new or has changed since it was recorded. Replays use your saved browser\n' +
        'session, so on sites where you are signed in it acts as you and can make real changes.\n' +
        'Review the plan first. Replay it? [y/N] ');
      if (!/^(y|yes)$/i.test(answer.trim())) throw new Cancelled('Replay cancelled.');
    } finally { prompt.close(); }
  }
  // Asked once: the same plan replays without asking again.
  if (plan.profileDir) await approvePlan(plan.profileDir, planText).catch(() => {});
}

// Some sites switch off JavaScript's eval (American Express replaces it with one that throws), which
// Stand-in's own small scripts in the page need. Keep the real one for those, and give the site's code the
// site's version, so the site's protection still applies to everything else.
function keepEvalInit() {
  const realEval = window.eval;
  let siteEval = realEval;
  try {
    Object.defineProperty(window, 'eval', {configurable: true,
      get() { return /UtilityScript/.test(new Error().stack ?? '') ? realEval : siteEval; },
      set(value) { siteEval = value; }});
  } catch {}
}

// Chrome records one tab, so the demo stays in one tab: links, forms and scripts that would open a new tab
// open in this one instead. Real pop-up windows (opened with a size, such as sign-in or payment windows)
// are left alone, because the site needs them to stay separate.
function oneTabInit() {
  const elsewhere = target => {
    if (!target || /^_(self|parent|top)$/i.test(target)) return false;
    if (target.toLowerCase() === '_blank') return true;
    try {
      for (let i = 0; i < top.frames.length; i++) if (top.frames[i].name === target) return false;
    } catch {}
    return true;
  };
  // Change the target only for this one click or submit, then put it back.
  const redirect = element => {
    const had = element.hasAttribute('target'), before = element.getAttribute('target');
    element.setAttribute('target', '_top');
    setTimeout(() => had ? element.setAttribute('target', before) : element.removeAttribute('target'));
  };
  addEventListener('click', e => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const link = e.composedPath().find(n => n instanceof Element && n.matches('a[href], area[href]'));
    if (link && elsewhere(link.getAttribute('target'))) redirect(link);
  }, true);
  addEventListener('submit', e => {
    const form = e.target;
    const button = e.submitter;
    if (button?.hasAttribute('formtarget') ? elsewhere(button.getAttribute('formtarget')) : elsewhere(form.getAttribute('target'))) {
      redirect(form);
      if (button?.hasAttribute('formtarget')) redirect(button);
    }
  }, true);
  const open = window.open;
  window.open = function (url, target, features) {
    const popupWindow = typeof features === 'string' && /\b(popup|width|height|left|top)\b/i.test(features);
    const address = url === undefined || url === null ? '' : String(url);
    if (popupWindow || !elsewhere(target ?? '_blank') || !address || address === 'about:blank')
      return open.apply(this, arguments);
    top.location.href = new URL(address, location.href).href;
    return top;
  };
}

// The rest of the one-tab rule, for tabs that still open (a middle-click, or a script that opens an empty tab
// and sets its address later): close the new tab and open its page in the recorded tab. Only while `active()`.
function keepInOneTab(ctx, page, {active}) {
  ctx.on('page', async other => {
    if (other === page || !active()) return;
    try {
      let url = other.url();
      if (!url || url === 'about:blank') {
        await other.waitForURL(u => u.href !== 'about:blank', {timeout: 5000}).catch(() => {});
        url = other.url();
      }
      // A pop-up window has no toolbar. Closing it would break the site (a sign-in, say), so leave it.
      const popupWindow = await other.evaluate(() => !window.toolbar.visible).catch(() => false);
      if (popupWindow) {
        log('The site opened a pop-up window, which isn\'t in the video. Finish there; the recording continues in the original tab.');
        return;
      }
      if (!url || url === 'about:blank' || !active()) {
        log('A new tab opened. It isn\'t in the video; switch back to the original tab to keep recording.');
        return;
      }
      await other.close().catch(() => {});
      log('Opened the new tab\'s page in the recorded tab instead, so it\'s in the video.');
      await page.bringToFront().catch(() => {});
      await page.goto(url, {waitUntil: 'commit', timeout: 45000});
    } catch (error) {
      if (!page.isClosed()) log(`A new tab opened and couldn't be moved into the recorded tab: ${error.message.split('\n')[0]}`);
    }
  });
}

function liveShortcutInit() {
  if (window.__standInLiveShortcut) return;
  window.__standInLiveShortcut = true;
  if (window === window.top) {
    let suppressed = false;
    window.__standInHideLiveHelp = () => {
      suppressed = true;
      document.querySelector('stand-in-live-help')?.remove();
    };
    window.__standInShowLiveHelp = async (restore = false) => {
      if (restore) suppressed = false;
      if (suppressed || !document.documentElement || await window.__standInLiveState() !== 'ready' || suppressed ||
          document.querySelector('stand-in-live-help')) return;
      const host = document.createElement('stand-in-live-help');
      Object.assign(host.style, {position: 'fixed', zIndex: '2147483647', bottom: '12px', left: '12px',
        pointerEvents: 'none', font: '14px system-ui'});
      const root = host.attachShadow({mode: 'open'});
      const panel = document.createElement('div');
      panel.setAttribute('role', 'status');
      Object.assign(panel.style, {background: '#171717', color: 'white', padding: '12px',
        borderRadius: '6px', maxWidth: '320px', lineHeight: '1.4'});
      const title = document.createElement('strong');
      title.textContent = 'Stand-in live recording';
      const shortcut = document.createElement('strong');
      shortcut.textContent = 'press Shift twice';
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.textContent = 'Dismiss';
      Object.assign(dismiss.style, {pointerEvents: 'auto', marginTop: '8px'});
      dismiss.addEventListener('click', window.__standInHideLiveHelp);
      panel.append(title, document.createElement('br'), 'Sign in first if needed. Then ',
        shortcut, ', quickly, to start. Do it again to stop and save. ' +
        'If that does nothing, click the page and try again, or press Enter in the terminal. ' +
        'Everything visible in this tab is recorded. This message disappears before recording.', document.createElement('br'), dismiss);
      root.append(panel);
      document.documentElement.append(host);
    };
    const show = () => window.__standInShowLiveHelp().catch(error =>
      console.error(`Stand-in instructions could not be shown: ${error.message}`));
    show();
    document.addEventListener('DOMContentLoaded', show, {once: true});
  }
  // Start and stop: press Shift twice, quickly, with nothing in between. Shift on its own types nothing,
  // so it never clashes with the site. A capital letter puts another key between the presses, and
  // Shift-clicking puts a click between them. Ctrl+Shift+9, the original shortcut, still works.
  const toggle = () =>
    window.__standInLiveToggle().catch(error => console.error(`Stand-in recording control failed: ${error.message}`));
  const DOUBLE_SHIFT_MS = 500;
  let lastShift = 0;
  addEventListener('keydown', e => {
    if (!e.isTrusted) return;
    if (e.key === 'Shift' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.repeat) { lastShift = 0; return; }
      const now = e.timeStamp;
      if (lastShift && now - lastShift <= DOUBLE_SHIFT_MS) {
        lastShift = 0;
        toggle();
      } else {
        lastShift = now;
      }
      return;
    }
    lastShift = 0;
    if (e.repeat || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || e.code !== 'Digit9') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toggle();
  }, true);
  for (const type of ['pointerdown', 'wheel']) addEventListener(type, () => { lastShift = 0; }, true);
}

async function liveRecording({ctx, page, plan, videoPath, startRecording = recordToFile, capture}) {
  let state = 'ready', recording;
  let resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // The tab can close before the caller starts awaiting completion.
  done.catch(() => {});
  // While recording, the tab's title shows a red dot and the time ("● 0:42 · Wikipedia"). It's where the
  // person is looking, and the title bar isn't part of the video.
  let ticker;
  const TITLE = /^● \d+:\d\d · /;
  const setTitle = label => page.evaluate(([label, pattern]) => {
    const own = document.title.replace(new RegExp(pattern), '');
    document.title = label ? `${label}${own}` : own;
  }, [label, TITLE.source]).catch(() => {});
  const showTimer = startedAt => {
    const tick = () => setTitle(`● ${clock((Date.now() - startedAt) / 1000)} · `);
    tick();
    ticker = setInterval(tick, 1000);
  };
  const hideTimer = () => { clearInterval(ticker); return state === 'stopping' && !page.isClosed() ? setTitle('') : undefined; };
  // Stopping, however it happens, saves everything recorded so far. `cutShort` says why it ended early.
  const save = async ({abandon = false, cutShort} = {}) => {
    state = 'stopping';
    hideTimer();
    log(cutShort ? `${cutShort} Saving what was recorded…` : 'Saving…');
    try {
      capture?.disarm();
      const video = await recording.stop({abandon});
      if (!video.size) {
        throw new UserError(cutShort ? `${cutShort} It was too soon for any video to be saved.` : 'Chrome returned an empty recording.');
      }
      if (capture) await capture.finish();
      state = 'saved';
      resolveDone({video: videoPath, cutShort});
      return state;
    } catch (error) {
      state = 'failed';
      rejectDone(error);
      throw error;
    }
  };
  // Closing the tab or Chrome while recording means "stop and save", not "throw it away".
  const ended = (whileReady, cutShort, abandon) => () => {
    if (state === 'ready' || state === 'starting') rejectDone(new (whileReady === CRASHED ? UserError : Cancelled)(whileReady));
    else if (state === 'recording') save({abandon, cutShort}).catch(() => {});
  };
  page.once('close', ended('The recorded tab was closed before recording started; nothing was recorded.', 'The recorded tab was closed.', true));
  page.once('crash', ended(CRASHED, 'The Chrome tab crashed, usually from running out of memory.', true));
  ctx.once('close', ended('Chrome was closed before recording started; nothing was recorded.', 'Chrome was closed.', true));
  await ctx.exposeBinding('__standInLiveState', ({page: source}) => source === page ? state : 'unavailable');
  // One state machine for every control: the shortcut in the page, Enter in the terminal, and Ctrl+C.
  const toggle = async ({cutShort} = {}) => {
    if (state === 'ready') {
      state = 'starting';
      try {
        await page.evaluate(() => new Promise((resolve, reject) => {
          window.__standInHideLiveHelp();
          const timer = setTimeout(() => reject(new Error('Could not clear recording instructions; focus the tab and try again.')), 3000);
          requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
        }));
        const startUrl = page.url();
        recording = await startRecording(page, {file: videoPath,
          frameRate: plan.fps, maxWidth: plan.viewport.width, maxHeight: plan.viewport.height, audio: !!plan.audio,
        });
        capture?.arm(startUrl);
      } catch (error) {
        state = 'ready';
        log(`Could not start recording: ${error.code === 'EEXIST' ? `${videoPath} already exists.` : error.message}`);
        try { await page.evaluate(() => window.__standInShowLiveHelp(true)); }
        catch { log('Could not show the instructions in the page again. Press Shift twice in the page to start, or Enter here.'); }
        throw error;
      }
      state = 'recording';
      showTimer(Date.now());
      log(`Recording this tab. Press Shift twice again${process.stdin.isTTY ? ' (or Enter here)' : ''} to stop and save.`);
      return state;
    }
    if (state !== 'recording') {
      log('Recording is already starting or stopping; wait for the terminal status.');
      throw new Error('Recording is already starting or stopping.');
    }
    return save({cutShort});
  };
  await ctx.exposeBinding('__standInLiveToggle', async ({page: source}) => {
    if (source !== page) {
      log('That tab is not the one being recorded. Switch back to the original tab, or press Enter in this terminal.');
      throw new Error('Focus the recorded tab to control recording.');
    }
    return toggle();
  });
  await ctx.addInitScript(liveShortcutInit);
  // Ctrl+C (or the terminal closing): save if recording, otherwise just stop.
  const interrupt = cutShort => {
    if (state === 'recording') return save({cutShort});
    if (state === 'ready') rejectDone(new Cancelled('Stopped before recording started; nothing was recorded.'));
    else log('Still saving the video; press Ctrl+C again to quit anyway.');
    return Promise.resolve(state);
  };
  return {done, toggle, interrupt, state: () => state};
}

// Lets people start and stop from the terminal (press Enter) when the page shortcut doesn't reach Chrome,
// for example because the page isn't focused. Only used when the terminal is interactive.
// Enter in the terminal starts and stops recording; Ctrl+C saves and stops (see `interrupted`).
function terminalControl({page, toggle, interrupt}) {
  interruption.handler = why => { interrupt(why).catch(() => {}); };
  let rl;
  if (process.stdin.isTTY) {
    rl = createInterface({input: process.stdin});
    rl.on('line', () => {
      page.bringToFront()
        .then(() => toggle())
        .catch(error => log(`Could not change recording: ${error.message}`));
    });
    // With the terminal in this mode, Ctrl+C arrives here instead of as a signal.
    rl.on('SIGINT', () => interrupted('SIGINT'));
  }
  return {close() { rl?.close(); interruption.handler = null; }};
}

async function liveCapture({ctx, page, plan, planPath, profileDir}) {
  const builder = new StepBuilder();
  let armed = false, startUrl, error, queue = Promise.resolve();
  await ctx.exposeBinding('__demoCaptureEvent', ({page: source, frame}, event) => {
    if (!armed || source !== page) return;
    queue = queue.then(async () => {
      const chain = await frameChain(frame);
      // A click in a pop-up shown in its own frame (a paywall or consent window) may not be needed on replay.
      if (chain && event.kind === 'click' && !event.dismiss && await inPopupFrame(frame)) event = {...event, dismiss: true};
      return builder.add(event, chain);
    }).catch(e => {
      error ??= e;
      log(`Could not capture an action: ${e.message}`);
    });
  });
  await ctx.addInitScript(captureInit);
  page.on('framenavigated', frame => { if (armed && frame === page.mainFrame()) builder.noteNavigation(Date.now()); });
  return {
    arm(url) { startUrl = url; armed = true; },
    disarm() { armed = false; },
    async finish() {
      await queue;
      const steps = builder.finish(Date.now());
      const raw = {url: startUrl, viewport: plan.viewport, fps: plan.fps,
        profileDir: relative(dirname(planPath), profileDir).split('\\').join('/'), steps};
      await mkdir(dirname(planPath), {recursive: true});
      const text = JSON.stringify(raw, null, 2) + '\n';
      await writeFile(planPath, text, {flag: 'wx'});
      // You recorded this yourself, so replaying it as recorded needs no confirmation.
      if (profileDir) await approvePlan(profileDir, text).catch(() => {});
      // The video is what matters most: a missed action only means the plan may need a step added.
      if (error) log(`An action couldn't be captured, so the replay plan may be missing a step: ${shown(planPath)}. The video is fine.`);
      if (builder.secrets) log('Password input was not captured; replace SET-ME in the replay plan if needed.');
    },
  };
}

// Is this frame (or one it sits in) a pop-up floating over the page: a paywall, offer or consent window?
// Those may not appear on replay, like any pop-up.
async function inPopupFrame(frame) {
  for (let f = frame; f?.parentFrame(); f = f.parentFrame()) {
    const el = await f.frameElement().catch(() => null);
    const popup = await el?.evaluate(n => {
      const POPUP = /cookie|consent|gdpr|banner|modal|popup|pop-up|overlay|lightbox|interstitial|survey|newsletter|promo|offer|paywall|gate|onetrust|didomi|sourcepoint|sp_message|cmp\b|piano|tp-/i;
      for (let e = n, i = 0; e && e.nodeType === 1 && i < 8; e = e.parentElement, i++) {
        if (/^(BODY|HTML)$/.test(e.tagName)) break;
        if (e.matches('[role=dialog],[role=alertdialog],dialog,[aria-modal=true]')) return true;
        const named = POPUP.test(`${e.id} ${typeof e.className === 'string' ? e.className : ''} ${e.getAttribute('title') ?? ''} ${e.getAttribute('name') ?? ''}`);
        if (named && /^(fixed|sticky|absolute)$/.test(getComputedStyle(e).position)) return true;
        if (e === n && named) return true;
      }
      return false;
    }).catch(() => false);
    await el?.dispose();
    if (popup) return true;
  }
  return false;
}

async function frameChain(frame) {
  const chain = [];
  for (let f = frame; f?.parentFrame(); f = f.parentFrame()) {
    // A frame that is navigating or being removed can't be inspected; fall back to its address.
    const el = await f.frameElement().catch(() => null);
    if (!el) {
      const src = f.url().split(/[?#]/)[0];
      chain.unshift(src && !/^(about|data|blob|javascript):/i.test(src) ? `iframe[src^=${JSON.stringify(src)}]` : 'iframe');
      continue;
    }
    chain.unshift(await el.evaluate(n => {
      // Ad and embed scripts often give frames made-up ids ("offer-0-WBVvC") that change on every visit.
      const made = s => /\d{3,}|[a-f0-9]{8,}|__|^(?::r|«r|_r_)/i.test(s) || s.split(/[-_:.]/).some(p => p.length >= 4 &&
        ((/\d/.test(p) && /[A-Z]/.test(p.slice(1))) ||
         (p.length <= 10 && (p.match(/[A-Z]/g) ?? []).length >= 2 && /[a-z]/.test(p) && !/^[A-Z]?[a-z]+(?:[A-Z][a-z]+)*$/.test(p))));
      const tag = n.tagName.toLowerCase(), q = v => JSON.stringify(v);
      if (n.getAttribute('title')) return `${tag}[title=${q(n.getAttribute('title'))}]`;
      if (n.id && !made(n.id)) return `#${CSS.escape(n.id)}`;
      if (n.getAttribute('name') && !made(n.getAttribute('name'))) return `${tag}[name=${q(n.getAttribute('name'))}]`;
      const src = n.getAttribute('src');
      if (src && !/^(about|data|blob|javascript):/i.test(src)) return `${tag}[src^=${q(src.split(/[?#]/)[0])}]`;
      if (n.id) return `#${CSS.escape(n.id)}`;
      const all = [...document.querySelectorAll(tag)];
      return all.length > 1 ? `${tag} >> nth=${all.indexOf(n)}` : tag;
    }).catch(() => 'iframe'));
    await el.dispose().catch(() => {});
  }
  return chain.length === 0 ? null : chain.length === 1 ? chain[0] : chain;
}

async function quickMain() {
  const {values: options, positionals} = parseArgs({allowPositionals: true, options: {
    help: {type: 'boolean', short: 'h'}, chrome: {type: 'string'}, output: {type: 'string'},
    rehearse: {type: 'boolean'}, headless: {type: 'boolean'}, 'confirm-signed-in': {type: 'boolean'},
    av1: {type: 'boolean'}, debug: {type: 'boolean'},
  }});
  if (options.debug) process.env.STAND_IN_DEBUG = '1';
  if (options.help || !positionals.length) {
    console.log(`Usage:
  stand-in <website>                          Record a video and save an editable replay plan
  stand-in replay <plan.json> [--rehearse]    Replay the plan, optionally without recording

Options:
  --output VIDEO.mp4     Where to save the video (default: recordings/<site>-<date>-<time>.mp4)
  --av1                  Keep Chrome's original AV1 video instead of converting it to H.264
  --confirm-signed-in    Replay without asking first (the plan can act as you on signed-in sites)
  --chrome PATH          Use this Chrome (version ${MIN_CHROME} or newer)
  --debug                Show technical details when something goes wrong

Press Shift twice, quickly, in the page to start and stop recording, or press Enter in the terminal.`);
    return;
  }
  requireSupportedNode(process.versions.node);
  // The VS Code extension names the folder to save into here, because VS Code can't always start the
  // recorder in that folder.
  const folder = process.env.STAND_IN_FOLDER;
  if (folder) {
    try { process.chdir(folder); } catch (error) {
      throw new UserError(error.code === 'ENOENT' ? `The folder for your videos doesn't exist: ${folder}`
        : `Stand-in can't use the folder for your videos, ${folder}: ${error.message}`);
    }
  }
  const replay = positionals[0] === 'replay';
  if ((replay && positionals.length !== 2) || (!replay && positionals.length !== 1))
    throw new UserError('Use stand-in <website URL> or stand-in replay <plan.json>.');
  if (!replay && (options.rehearse || options.headless))
    throw new UserError('Live recording requires visible Chrome; --rehearse is only for replay.');
  if (options.rehearse && options.output)
    throw new UserError('--output cannot be used with --rehearse.');

  let plan, planPath, videoPath;
  if (replay) {
    planPath = resolve(positionals[1]);
    let raw;
    try { raw = JSON.parse(await readFile(planPath, 'utf8')); } catch (error) {
      throw new UserError(error.code === 'ENOENT' ? `There is no replay plan at ${planPath}.`
        : `Couldn't read the replay plan ${shown(planPath)}: ${error.message}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new UserError('The replay plan must be a JSON object.');
    const supported = new Set(['$schema', 'description', 'notes', 'url', 'steps', 'viewport', 'zoom', 'fps', 'audio',
      'pace', 'cursor', 'accent', 'constantFrameRate', 'profileDir', 'signedIn', 'leadInMs', 'tailMs', 'timeout', 'chrome', 'overlay']);
    const unsupported = Object.keys(raw).filter(key => !supported.has(key));
    if (unsupported.length)
      throw new UserError(`Unsupported plan fields: ${unsupported.join(', ')}. Older profile, setup, masking and private workflows were removed; existing files are unchanged.`);
    if (typeof raw.url !== 'string' || !Array.isArray(raw.steps))
      throw new UserError('The replay plan must contain a URL and an array of steps.');
    plan = normalisePlan(await loadPlan(planPath));
    if (plan.steps.some(s => [s.text, s.value, s.label].some(v => typeof v === 'string' && v.startsWith('SET-ME:'))))
      throw new UserError('The plan contains uncaptured password input. Review it and replace SET-ME before replay.');
    await confirmSignedInReplay(plan, await readFile(planPath, 'utf8'), options['confirm-signed-in']);
    if (plan.profileDir && !existsSync(plan.profileDir))
      throw new UserError(`The browser session ${plan.profileDir} is missing; record a new demo or update the plan.`);
    if (options.output) videoPath = resolve(options.output);
    else {
      const name = freeName(`${basename(planPath, '.json')}-replay`,
        n => resolve('recordings', `${n}.mp4`), n => resolve('recordings', `${n}-incomplete.mp4`));
      videoPath = resolve('recordings', `${name}.mp4`);
    }
  } else {
    let url;
    // "wikipedia.org" is what people type; add the https:// for them.
    const typed = /^[a-z][a-z0-9+.-]*:\/\//i.test(positionals[0]) ? positionals[0]
      : `${/^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(positionals[0]) ? 'http' : 'https'}://${positionals[0]}`;
    try { url = new URL(typed); } catch { throw new UserError('Enter a website address, such as https://example.com.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname)
      throw new UserError('Enter an http or https website address without a user name or password in it.');
    if (typed !== positionals[0] && !url.hostname.includes('.') && url.hostname !== 'localhost')
      throw new UserError(`"${positionals[0]}" isn't a complete website address. Enter one such as example.com.`);
    const name = freeName(`${siteName(url)}-${localStamp()}`,
      n => resolve('demos', `${n}.json`), n => resolve('recordings', `${n}.mp4`));
    planPath = resolve('demos', `${name}.json`);
    videoPath = resolve(options.output ?? join('recordings', `${name}.mp4`));
    plan = normalisePlan({url: url.href, profileDir: resolve('.sessions', 'stand-in')});
  }
  if (!/\.mp4$/i.test(videoPath)) throw new UserError('Video output must end in .mp4.');
  if (!options.rehearse && existsSync(videoPath)) throw new UserError(`Video already exists: ${videoPath}. Choose a new output path.`);

  const {chromium} = await loadDeps();
  const chromePath = await findChrome(options.chrome ?? plan.chrome);
  const {width: W, height: H} = plan.viewport;
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  // Stand-in handles Ctrl+C itself (to save the video first); Playwright would otherwise close Chrome and exit.
  const launch = {executablePath: chromePath, headless: !!options.headless,
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    viewport: {width: W, height: H}, deviceScaleFactor: 1,
    args: [`--window-size=${W},${H}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    proxy: proxy ? {server: proxy, bypass: process.env.NO_PROXY ?? process.env.no_proxy} : undefined};
  const convert = !options.av1;
  let browser, ctx, saved, failure;
  listenForInterruptions(async () => {
    if (browser) await browser.close().catch(() => {});
    else if (ctx) await ctx.close().catch(() => {});
  });
  try {
    if (plan.profileDir) {
      ctx = await chromium.launchPersistentContext(plan.profileDir, launch).catch(error => {
        if (/ProcessSingleton|profile.*in use|user data directory is already in use/i.test(error.message))
          throw new UserError('Another Stand-in Chrome window is still open with the same browser session. Close it and try again.');
        throw error;
      });
    } else {
      browser = await chromium.launch(launch);
      ctx = await browser.newContext({viewport: launch.viewport, deviceScaleFactor: 1});
    }
    const page = ctx.pages()[0] ?? await ctx.newPage();
    if (!replay) {
      const bounds = await page.evaluate(() => ({width: outerWidth, height: outerHeight}));
      if (bounds.width > 200 && bounds.height > 200) {
        const scale = Math.min(1, (bounds.width - 48) / W, (bounds.height - 128) / H);
        if (scale < 1) {
          // Even sizes: video encoders need them.
          plan.viewport = {width: Math.round(W * scale / 2) * 2, height: Math.round(H * scale / 2) * 2};
          await page.setViewportSize(plan.viewport);
        }
      }
    }
    await ctx.addInitScript(keepEvalInit);
    await ctx.addInitScript(overlayInit, plan.overlay);
    await ctx.addInitScript(oneTabInit);
    if (!replay) {
      const capture = await liveCapture({ctx, page, plan, planPath, profileDir: plan.profileDir});
      const {done, toggle, interrupt, state} = await liveRecording({ctx, page, plan, videoPath, capture});
      keepInOneTab(ctx, page, {active: () => state() === 'recording'});
      page.on('dialog', d => log(`Browser ${d.type()} dialog: respond in Chrome.`));
      try {
        await page.goto(plan.url, {waitUntil: 'domcontentloaded', timeout: 45000});
      } catch (error) {
        // A slow site isn't a reason to give up: the page keeps loading while you get ready.
        if (error.name !== 'TimeoutError') throw new UserError(explainNavigation(error, plan.url));
        log('The page is taking a long time to load. Start recording when it is ready.');
      }
      // Chrome opens with the address bar focused, where the shortcut can't be seen. Focus the page.
      await page.bringToFront().catch(() => {});
      await page.evaluate(() => { window.focus(); document.activeElement?.blur?.(); }).catch(() => {});
      const terminal = terminalControl({page, toggle, interrupt});
      log(`Ready. Press Shift twice, quickly, in the page to start recording${process.stdin.isTTY ? ' (or press Enter here)' : ''}.`);
      log('Everything in this tab is recorded; the video, plan and .sessions folder can contain private information.');
      let result;
      try { result = await done; } finally { terminal.close(); }
      saved = {video: videoPath, plan: planPath, cutShort: result?.cutShort, trim: true};
      return;
    }
    if (plan.zoom && plan.zoom !== 1)
      await ctx.addInitScript(z => { const set = () => { if (document.documentElement) document.documentElement.style.zoom = z; };
        set(); document.addEventListener('DOMContentLoaded', set); }, String(plan.zoom));
    page.on('dialog', d => { log(`Accepting browser ${d.type()} dialog during replay.`); d.accept().catch(e => log(`Dialog failed: ${e.message}`)); });
    keepInOneTab(ctx, page, {active: () => !page.isClosed()});
    log(`Replaying ${shown(planPath)} on ${plan.url}`);
    try {
      await page.goto(plan.url, {waitUntil: 'load', timeout: 45000});
    } catch (error) {
      if (error.name !== 'TimeoutError') throw new UserError(explainNavigation(error, plan.url));
      log('The page is slow to finish loading; continuing anyway.');
    }
    // A crashed tab never answers again, and Ctrl+C means "stop here": either way, stop waiting and keep the video.
    let stopReplay, tabCrashed = false;
    const crash = new Promise((_, reject) => { stopReplay = reject; });
    crash.catch(() => {});
    page.once('crash', () => { tabCrashed = true; stopReplay(new UserError(CRASHED)); });
    interruption.handler = why => stopReplay(new UserError(why));
    const stopListening = () => { interruption.handler = null; };
    const actor = new Actor(page, plan);
    await actor.settle();
    let recording;
    if (!options.rehearse) {
      await page.mouse.move(actor.mouse.x, actor.mouse.y);
      recording = await recordToFile(page, {file: videoPath, frameRate: plan.fps, maxWidth: W, maxHeight: H, audio: !!plan.audio});
      await page.waitForTimeout(plan.leadInMs);
    }
    const total = plan.steps.length, width = String(total).length;
    try {
      for (const [index, step] of plan.steps.entries()) {
        const what = describeStep(step);
        log(`${String(index + 1).padStart(width)}/${total}  ${what}`);
        const timeout = step.timeout ?? plan.timeout;
        try {
          await Promise.race([crash, (async () => {
            const began = Date.now();
            await actor.run(step, timeout);
            if (step.action === 'waitForStable' && step.around && step.requireChange !== false && actor.lastWait?.warning)
              throw new AssistantResponseError(actor.lastWait.warning);
            await actor.settle(began);
            await actor.wait(step.pauseAfter ?? actor.defaultPauseAfter(step));
          })()]);
        } catch (error) {
          if (error instanceof UserError && !step.optional) throw error; // crashed or stopped
          const why = explainError(error, {...step, timeout});
          if (step.optional) { log(`${' '.repeat(width * 2 + 3)}skipped (optional): ${why}`); continue; }
          const location = shown(planPath);
          throw new UserError(`Step ${index + 1} of ${total} failed: ${what}\n  ${why}\n` +
            (error instanceof AssistantResponseError ? '  The assistant may not have answered, or answered somewhere Stand-in was not watching.\n' :
              '  The page may have changed, or it was still loading.\n') +
            `  To fix it, edit step ${index + 1} in ${location}: change its "target", give it a longer "timeout",\n` +
            '  or add "optional": true to skip it when it is missing. Try it without recording: add --rehearse.');
        }
      }
      if (recording) await Promise.race([crash, page.waitForTimeout(plan.tailMs)]);
    } catch (error) {
      await sleep(300); // a crash is reported just after the error it causes
      failure = tabCrashed ? new UserError(CRASHED) : error;
    } finally { stopListening(); }
    if (recording) {
      const video = await recording.stop({abandon: tabCrashed});
      if (video.size) {
        const target = failure ? videoPath.replace(/\.mp4$/i, '-incomplete.mp4') : videoPath;
        if (target !== videoPath) await rename(videoPath, target);
        saved = {video: target, plan: planPath, incomplete: !!failure};
      } else if (!failure) throw new Error('Chrome returned an empty replay recording.');
    }
    if (options.rehearse && !failure) log('Rehearsal passed: every step worked.');
  } finally {
    if (browser) await browser.close().catch(() => {});
    else if (ctx) await ctx.close().catch(() => {});
    // Chrome has closed; now make the video play everywhere and say where it is.
    if (saved?.video && existsSync(saved.video)) {
      const length = await finishVideo({chromium, chromePath, file: saved.video, convert, trim: saved.trim});
      if (saved.trim && saved.plan && existsSync(saved.plan)) log(`Replay plan: ${shown(saved.plan)}`);
      if (saved.incomplete) log(`Saved what was recorded before the problem: ${shown(saved.video)}`);
      else log(`Your video is ready: ${shown(saved.video)}${length}`);
      await writeResult({ok: !failure, video: saved.video, plan: saved.plan, error: failure?.message});
    }
  }
  if (failure) throw failure;
}

export {Actor, captureInit, keepEvalInit, keepInOneTab, oneTabInit, findChrome, keepWholeFragments, liveCapture, liveRecording, makePlayable, recordToFile, requireSupportedNode, StepBuilder};

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  quickMain().catch(async error => {
    if (error instanceof Cancelled) { log(error.message); process.exit(0); }
    await writeResult({ok: false, error: error.message, link: error.link});
    if (error instanceof UserError) die(error.message);
    // Something unexpected: keep the message short, with details on request.
    if (process.env.STAND_IN_DEBUG) die(error.stack ?? String(error));
    die(`${explainError(error)}\n  Run again with --debug for technical details.`);
  });
