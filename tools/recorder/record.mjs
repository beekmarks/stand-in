#!/usr/bin/env node
// Capture a website tab and optionally replay its recorded actions with visual effects.

import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync, realpathSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {homedir, platform} from 'node:os';
import {basename, dirname, join, relative, resolve} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';

const MIN_CHROME = 153;

// ------------------------------------------------------------------------------------------
// Dependencies are installed with the package.
// ------------------------------------------------------------------------------------------
async function loadDeps() {
  const [pw, cc] = await Promise.all([import('playwright-core'), import('chrome-capture')]);
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
  addEventListener('pointerdown', e => {
    if (e.isTrusted && e.button === 0) down = {x: e.clientX, y: e.clientY, el: e.target};
  }, true);
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
    send({kind: 'select', target: targetFor(e.target),
      value: e.target.value, label: clean(o?.textContent)});
  }, true);
  addEventListener('keydown', e => {
    if (!e.isTrusted || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'Digit9') return;
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

class StepBuilder {
  constructor() {
    this.steps = []; this.typing = null; this.lastT = 0; this.lastWheelT = 0; this.secrets = 0; this.lastSubmit = null;
  }
  same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  flush() {
    if (!this.typing) return;
    const {target, text, submit, secret} = this.typing;
    const step = {action: 'type', target, text: secret ? 'SET-ME: password (not captured)' : text, clear: true};
    if (submit) step.submit = true;
    if (secret) this.secrets++;
    const prev = this.steps.at(-1);
    if (prev?.action === 'click' && this.same(prev.target, target)) this.steps.pop();
    this.steps.push(step);
    this.typing = null;
  }
  gap(t) {
    const g = this.lastT ? t - this.lastT : 0;
    const prev = this.steps.at(-1);
    if (g > 2500 && prev && prev.action !== 'wait')
      this.steps.push({action: 'wait', ms: Math.min(Math.round(g / 100) * 100, 30000)});
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
        if (!this.typing) this.typing = {target, text: ev.value, secret: ev.secret};
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
    // A link that wraps onto two lines has a bounding box covering both lines, and its centre is often plain
    // text, not the link. So aim at one of the element's own line boxes: the first one whose centre really
    // is the element (hit-tested), else the largest one.
    let r = await h.evaluate(e => {
      const whole = e.getBoundingClientRect();
      const parts = [...e.getClientRects()].filter(b => b.width > 1 && b.height > 1);
      if (parts.length < 2) return {x: whole.x, y: whole.y, width: whole.width, height: whole.height};
      const hits = b => {
        const t = e.ownerDocument.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
        return !!t && (t === e || e.contains(t));
      };
      const byArea = [...parts].sort((a, b) => b.width * b.height - a.width * a.height);
      const b = byArea.find(hits) ?? byArea[0];
      return {x: b.x, y: b.y, width: b.width, height: b.height};
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

  // After anything that might navigate: let the new page settle and put the cursor back.
  async settle() {
    try { await this.page.waitForLoadState('load', {timeout: 15000}); } catch {}
    try { await this.page.evaluate(() => document.fonts?.ready); } catch {}
    try { await this.page.mouse.move(this.mouse.x, this.mouse.y); } catch {}
  }
}

// ------------------------------------------------------------------------------------------
// Main
// ------------------------------------------------------------------------------------------
function log(...a) { console.error('[stand-in]', ...a); }
function die(msg) { console.error(`[stand-in] ERROR: ${msg}`); process.exit(1); }
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

function requireSupportedNode(version) {
  const [major, minor] = version.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 11))
    throw new Error(`Node.js 24.11 or newer is required (found ${version}). Install or select a supported version, then fully quit and reopen VS Code.`);
}

async function confirmSignedInReplay(plan, approved) {
  if (!(plan.signedIn || plan.profileDir) || approved) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    die('Signed-in replay needs explicit approval. Review the plan for actions that change real data, then rerun with --confirm-signed-in.');
  const prompt = createInterface({input: process.stdin, output: process.stdout});
  try {
    const answer = await prompt.question('This replay can make real changes to the signed-in site. Review the plan first. Continue? [y/N] ');
    if (!/^(y|yes)$/i.test(answer.trim())) die('Signed-in replay cancelled.');
  } finally { prompt.close(); }
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
      shortcut.textContent = 'Ctrl+Shift+9';
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.textContent = 'Dismiss';
      Object.assign(dismiss.style, {pointerEvents: 'auto', marginTop: '8px'});
      dismiss.addEventListener('click', window.__standInHideLiveHelp);
      panel.append(title, document.createElement('br'), 'Sign in first if needed. With this page focused, press ',
        shortcut, ' to start. Wait for the terminal to say recording, then press it again to stop and save. ' +
        'Everything visible in this tab is recorded. On Mac, use Control, not Command. ' +
        'This message disappears before recording.', document.createElement('br'), dismiss);
      root.append(panel);
      document.documentElement.append(host);
    };
    const show = () => window.__standInShowLiveHelp().catch(error =>
      console.error(`Stand-in instructions could not be shown: ${error.message}`));
    show();
    document.addEventListener('DOMContentLoaded', show, {once: true});
  }
  addEventListener('keydown', e => {
    if (!e.isTrusted || e.repeat || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || e.code !== 'Digit9') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    window.__standInLiveToggle().catch(error => console.error(`Stand-in recording control failed: ${error.message}`));
  }, true);
}

async function liveRecording({ctx, page, plan, videoPath, startRecording, capture}) {
  let state = 'ready', recording;
  let resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // The tab can close before the caller starts awaiting completion.
  done.catch(() => {});
  page.once('close', () => rejectDone(new Error(state === 'ready'
    ? 'The recorded tab closed before recording started.'
    : 'The recorded tab closed before the recording could be saved; press Ctrl+Shift+9 before closing it.')));
  ctx.once('close', () => rejectDone(new Error('Chrome closed before the recording was saved.')));
  await ctx.exposeBinding('__standInLiveState', ({page: source}) => source === page ? state : 'unavailable');
  await ctx.exposeBinding('__standInLiveToggle', async ({page: source}) => {
    if (source !== page) {
      log('Focus the recorded tab to control recording.');
      throw new Error('Focus the recorded tab to control recording.');
    }
    if (state === 'ready') {
      state = 'starting';
      try {
        await page.evaluate(() => new Promise((resolve, reject) => {
          window.__standInHideLiveHelp();
          const timer = setTimeout(() => reject(new Error('Could not clear recording instructions; focus the tab and try again.')), 3000);
          requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
        }));
        const startUrl = page.url();
        recording = await startRecording(page, {
          frameRate: plan.fps, maxWidth: plan.viewport.width, maxHeight: plan.viewport.height, audio: !!plan.audio,
        });
        capture?.arm(startUrl);
      } catch (error) {
        state = 'ready';
        log(`Could not start recording: ${error.message}`);
        try { await page.evaluate(() => window.__standInShowLiveHelp(true)); }
        catch { log('Could not restore the on-page shortcut instructions; see the terminal for the shortcut.'); }
        throw error;
      }
      state = 'recording';
      log('Recording this tab. Press Ctrl+Shift+9 again to stop and save.');
      return state;
    }
    if (state !== 'recording') {
      log('Recording is already starting or stopping; wait for the terminal status.');
      throw new Error('Recording is already starting or stopping.');
    }
    state = 'stopping';
    try {
      capture?.disarm();
      const video = await recording.stop();
      if (!video.length) throw new Error('Chrome returned an empty recording.');
      await mkdir(dirname(videoPath), {recursive: true});
      await writeFile(videoPath, video, {flag: 'wx'});
      log(`Saved ${videoPath}`);
      if (capture) await capture.finish();
      state = 'saved';
      resolveDone();
      return state;
    } catch (error) {
      state = 'failed';
      rejectDone(error);
      throw error;
    }
  });
  await ctx.addInitScript(liveShortcutInit);
  return {done};
}

async function liveCapture({ctx, page, plan, planPath, profileDir}) {
  const builder = new StepBuilder();
  let armed = false, startUrl, error, queue = Promise.resolve();
  await ctx.exposeBinding('__demoCaptureEvent', ({page: source, frame}, event) => {
    if (!armed || source !== page) return;
    queue = queue.then(async () => builder.add(event, await frameChain(frame))).catch(e => {
      error ??= e;
      log(`Could not capture an action: ${e.message}`);
    });
  });
  await ctx.addInitScript(captureInit);
  return {
    arm(url) { startUrl = url; armed = true; },
    disarm() { armed = false; },
    async finish() {
      await queue;
      const steps = builder.finish(Date.now());
      const raw = {url: startUrl, viewport: plan.viewport, fps: plan.fps,
        profileDir: relative(dirname(planPath), profileDir).split('\\').join('/'), steps};
      await mkdir(dirname(planPath), {recursive: true});
      await writeFile(planPath, JSON.stringify(raw, null, 2) + '\n', {flag: 'wx'});
      log(`Saved replay plan ${planPath}${error ? ' (incomplete)' : ''}`);
      if (builder.secrets) log('Password input was not captured; replace SET-ME in the replay plan if needed.');
      if (error) throw new Error('The video was saved, but some actions could not be captured. Review the incomplete plan.');
    },
  };
}

async function frameChain(frame) {
  const chain = [];
  for (let f = frame; f?.parentFrame(); f = f.parentFrame()) {
    const el = await f.frameElement();
    chain.unshift(await el.evaluate(n => {
      return n.id ? `#${CSS.escape(n.id)}` : n.getAttribute('name') ? `iframe[name="${n.getAttribute('name')}"]`
        : n.getAttribute('title') ? `iframe[title="${n.getAttribute('title')}"]` : n.getAttribute('src') ? `iframe[src="${n.getAttribute('src')}"]` : 'iframe';
    }));
  }
  return chain.length === 0 ? null : chain.length === 1 ? chain[0] : chain;
}

async function quickMain() {
  const {values: options, positionals} = parseArgs({allowPositionals: true, options: {
    help: {type: 'boolean', short: 'h'}, chrome: {type: 'string'}, output: {type: 'string'},
    rehearse: {type: 'boolean'}, headless: {type: 'boolean'}, 'confirm-signed-in': {type: 'boolean'},
  }});
  if (options.help || !positionals.length) {
    console.log(`Usage:
  stand-in <https://website>                  Record a video and save an editable replay plan
  stand-in replay <plan.json> [--rehearse]    Replay the plan, optionally without recording

Options: --chrome PATH, --output VIDEO.mp4, --confirm-signed-in
Press Ctrl+Shift+9 in the page to start and stop recording.`);
    return;
  }
  requireSupportedNode(process.versions.node);
  const replay = positionals[0] === 'replay';
  if ((replay && positionals.length !== 2) || (!replay && positionals.length !== 1))
    throw new Error('Use stand-in <website URL> or stand-in replay <plan.json>.');
  if (!replay && (options.rehearse || options.headless))
    throw new Error('Live recording requires visible Chrome; --rehearse is only for replay.');
  if (options.rehearse && options.output)
    throw new Error('--output cannot be used with --rehearse.');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let plan, planPath, videoPath;
  if (replay) {
    planPath = resolve(positionals[1]);
    const raw = JSON.parse(await readFile(planPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('The replay plan must be a JSON object.');
    const supported = new Set(['$schema', 'description', 'notes', 'url', 'steps', 'viewport', 'zoom', 'fps', 'audio',
      'pace', 'cursor', 'accent', 'constantFrameRate', 'profileDir', 'signedIn', 'leadInMs', 'tailMs', 'timeout', 'chrome', 'overlay']);
    const unsupported = Object.keys(raw).filter(key => !supported.has(key));
    if (unsupported.length)
      throw new Error(`Unsupported plan fields: ${unsupported.join(', ')}. Older profile, setup, masking and private workflows were removed; existing files are unchanged.`);
    if (typeof raw.url !== 'string' || !Array.isArray(raw.steps))
      throw new Error('The replay plan must contain a URL and an array of steps.');
    plan = normalisePlan(await loadPlan(planPath));
    if (plan.steps.some(s => [s.text, s.value, s.label].some(v => typeof v === 'string' && v.startsWith('SET-ME:'))))
      throw new Error('The plan contains uncaptured password input. Review it and replace SET-ME before replay.');
    await confirmSignedInReplay(plan, options['confirm-signed-in']);
    if (plan.profileDir && !existsSync(plan.profileDir))
      throw new Error(`The browser session ${plan.profileDir} is missing; record a new demo or update the plan.`);
    videoPath = resolve(options.output ?? join('recordings', `${basename(planPath, '.json')}-replay-${stamp}.mp4`));
  } else {
    let url;
    try { url = new URL(positionals[0]); } catch { throw new Error('Enter a complete website URL, such as https://example.com.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Enter an http or https website URL without embedded credentials.');
    const name = `${url.hostname.replace(/[^a-z0-9-]+/gi, '-')}-${stamp}`;
    planPath = resolve('demos', `${name}.json`);
    videoPath = resolve(options.output ?? join('recordings', `${name}.mp4`));
    plan = normalisePlan({url: url.href, profileDir: resolve('.sessions', 'stand-in')});
    if (existsSync(planPath)) throw new Error(`Replay plan already exists: ${planPath}. Try again.`);
  }
  if (!/\.mp4$/i.test(videoPath)) throw new Error('Video output must end in .mp4.');
  if (!options.rehearse && existsSync(videoPath)) throw new Error(`Video already exists: ${videoPath}. Choose a new output path.`);

  const {chromium, startRecording, findChromeBinary} = await loadDeps();
  const chromePath = await findChrome(options.chrome ?? plan.chrome, findChromeBinary);
  const {width: W, height: H} = plan.viewport;
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const launch = {executablePath: chromePath, headless: !!options.headless,
    viewport: {width: W, height: H}, deviceScaleFactor: 1,
    args: [`--window-size=${W},${H}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    proxy: proxy ? {server: proxy, bypass: process.env.NO_PROXY ?? process.env.no_proxy} : undefined};
  let browser, ctx;
  try {
    if (plan.profileDir) {
      ctx = await chromium.launchPersistentContext(plan.profileDir, launch);
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
          plan.viewport = {width: Math.round(W * scale), height: Math.round(H * scale)};
          await page.setViewportSize(plan.viewport);
        }
      }
    }
    await ctx.addInitScript(overlayInit, plan.overlay);
    if (!replay) {
      const capture = await liveCapture({ctx, page, plan, planPath, profileDir: plan.profileDir});
      const {done} = await liveRecording({ctx, page, plan, videoPath, startRecording, capture});
      page.on('dialog', d => log(`Browser ${d.type()} dialog: respond in Chrome.`));
      await page.goto(plan.url, {waitUntil: 'domcontentloaded', timeout: 45000});
      log('Sign in if needed. Press Ctrl+Shift+9 in the page to start, then again to stop and save.');
      log('The video captures this tab. The video, replay plan and saved browser session may contain sensitive information.');
      await done;
      return;
    }
    if (plan.zoom && plan.zoom !== 1)
      await ctx.addInitScript(z => { const set = () => { if (document.documentElement) document.documentElement.style.zoom = z; };
        set(); document.addEventListener('DOMContentLoaded', set); }, String(plan.zoom));
    page.on('dialog', d => { log(`Accepting browser ${d.type()} dialog during replay.`); d.accept().catch(e => log(`Dialog failed: ${e.message}`)); });
    await page.goto(plan.url, {waitUntil: 'load', timeout: 45000});
    const actor = new Actor(page, plan);
    await actor.settle();
    let recording;
    if (!options.rehearse) {
      await page.mouse.move(actor.mouse.x, actor.mouse.y);
      recording = await startRecording(page, {frameRate: plan.fps, maxWidth: W, maxHeight: H, audio: !!plan.audio});
      await page.waitForTimeout(plan.leadInMs);
    }
    let failure;
    try {
      for (const [index, step] of plan.steps.entries()) {
        try {
          await actor.run(step, step.timeout ?? plan.timeout);
          if (step.action === 'waitForStable' && step.around && step.requireChange !== false && actor.lastWait?.warning)
            throw new AssistantResponseError(actor.lastWait.warning);
          await actor.settle();
          await actor.wait(step.pauseAfter ?? actor.defaultPauseAfter(step));
          log(`Replayed step ${index + 1}: ${step.action}`);
        } catch (error) {
          if (!step.optional) throw error;
          log(`Skipped optional step ${index + 1}: ${error.message}`);
        }
      }
      if (recording) await page.waitForTimeout(plan.tailMs);
    } catch (error) { failure = error; }
    if (recording) {
      const video = await recording.stop();
      if (!video.length) throw new Error('Chrome returned an empty replay recording.');
      const target = failure ? videoPath.replace(/\.mp4$/i, '.partial.mp4') : videoPath;
      await mkdir(dirname(target), {recursive: true});
      await writeFile(target, video, {flag: 'wx'});
      log(`Saved ${target}`);
    }
    if (failure) throw failure;
    if (options.rehearse) log('Rehearsal passed.');
  } finally {
    if (browser) await browser.close();
    else if (ctx) await ctx.close();
  }
}

export {Actor, captureInit, findChrome, liveCapture, liveRecording, requireSupportedNode, StepBuilder};

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  quickMain().catch(e => die(e.stack ?? String(e)));
