// Electron main process of the screenshot harness. Never shows a window: every BrowserWindow is `show: false` and
// offscreen, and the Dock icon is hidden first thing. Started by shoot.mjs, which sets the environment:
//   SHOTS         output folder for the PNGs
//   SHOTS_DIST    folder with the built app (dist/) and the harness bundles (dist/shots/)
//   SHOTS_SCENES  comma-separated scene names (empty: all)
//   REDUCED=1     emulate prefers-reduced-motion: reduce (files get a "-reduced" suffix)
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.dock?.hide();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
if (process.env.SHOTS_DISABLE_GPU !== '0') app.commandLine.appendSwitch('disable-gpu');

const WIDTH = 1280;
const HEIGHT = 820;
const BOOT_MS = 1500; // the app boots and the scene's events (500 ms after subscribing) have landed
const SETTLE_MS = 900; // after the last step: transitions are 240 ms
const STEP_TIMEOUT_MS = 6000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = process.env.SHOTS;
const dist = process.env.SHOTS_DIST;
const reduced = process.env.REDUCED === '1';

// A throwaway profile: the harness never touches the real app data (or its localStorage).
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'coa-shots-')));

/** Runs in the renderer: waits for an element, clicks it. */
const clickScript = (c) => `(async () => {
  const c = ${JSON.stringify(c)};
  const end = Date.now() + ${STEP_TIMEOUT_MS};
  for (;;) {
    let els = [...document.querySelectorAll(c.selector)];
    if (c.text) els = els.filter((e) => (e.textContent || '').includes(c.text) || (e.getAttribute('aria-label') || '').includes(c.text));
    const i = c.index === undefined ? 0 : c.index < 0 ? els.length + c.index : c.index;
    if (els[i]) { els[i].click(); return true; }
    if (Date.now() > end) throw new Error('not found: ' + JSON.stringify(c));
    await new Promise((r) => setTimeout(r, 50));
  }
})()`;

const waitForScript = (selector) => `(async () => {
  const end = Date.now() + ${STEP_TIMEOUT_MS};
  while (!document.querySelector(${JSON.stringify(selector)})) {
    if (Date.now() > end) throw new Error('not found: ' + ${JSON.stringify(selector)});
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
})()`;

/** Runs in the renderer: sends one AppEvent through the mock's `emit`. */
const emitScript = (event) => `(() => { window.coa.emit(${JSON.stringify(event)}); return true; })()`;

const scrollScript = (c) => `(() => { const e = document.querySelector(${JSON.stringify(c.selector)}); if (!e) throw new Error('not found: ' + ${JSON.stringify(c.selector)}); e.scrollTop = ${c.to === 'bottom' ? 'e.scrollHeight' : '0'}; return true; })()`;

/** Runs in the renderer: picks `value` in the `index`-th <select> matching `selector`, as a user would (React sees a change). */
const selectScript = (c) => `(async () => {
  const c = ${JSON.stringify(c)};
  const end = Date.now() + ${STEP_TIMEOUT_MS};
  for (;;) {
    const els = [...document.querySelectorAll(c.selector)];
    const el = els[c.index === undefined ? 0 : c.index];
    if (el) {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, c.value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (Date.now() > end) throw new Error('not found: ' + JSON.stringify(c));
    await new Promise((r) => setTimeout(r, 50));
  }
})()`;

/** Runs in the renderer: pastes or drops files on the element with a real ClipboardEvent or DragEvent (Chromium accepts a DataTransfer built in script). */
const filesScript = (c) => `(async () => {
  const c = ${JSON.stringify(c)};
  const end = Date.now() + ${STEP_TIMEOUT_MS};
  let el = document.querySelector(c.selector);
  while (!el) {
    if (Date.now() > end) throw new Error('not found: ' + c.selector);
    await new Promise((r) => setTimeout(r, 50));
    el = document.querySelector(c.selector);
  }
  const dt = new DataTransfer();
  for (const it of c.items) {
    const bin = atob(it.data);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    dt.items.add(new File([bytes], it.name, { type: it.type }));
  }
  const init = { bubbles: true, cancelable: true };
  el.dispatchEvent(c.event === 'paste' ? new ClipboardEvent('paste', { ...init, clipboardData: dt }) : new DragEvent('drop', { ...init, dataTransfer: dt }));
  await new Promise((r) => setTimeout(r, 300));
  return true;
})()`;

/** Runs in the renderer: types `value` into the `index`-th <input> or <textarea> matching `selector`, as a user would (React sees an input event). */
const typeScript = (c) => `(async () => {
  const c = ${JSON.stringify(c)};
  const end = Date.now() + ${STEP_TIMEOUT_MS};
  for (;;) {
    const els = [...document.querySelectorAll(c.selector)];
    const el = els[c.index === undefined ? 0 : c.index];
    if (el) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, c.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    if (Date.now() > end) throw new Error('not found: ' + JSON.stringify(c));
    await new Promise((r) => setTimeout(r, 50));
  }
})()`;

/** Runs in the renderer: does the focused element match? */
const focusedScript = (c) => `(() => {
  const a = document.activeElement;
  if (!a || !a.matches(${JSON.stringify(c.selector)})) return false;
  return ${JSON.stringify(c.text || '')} === '' || (a.textContent || '').includes(${JSON.stringify(c.text || '')}) || (a.getAttribute('aria-label') || '').includes(${JSON.stringify(c.text || '')});
})()`;

/** Runs in the renderer: the centre of an element, in CSS pixels. */
const centreScript = (c) => `(async () => {
  const end = Date.now() + ${STEP_TIMEOUT_MS};
  for (;;) {
    let els = [...document.querySelectorAll(${JSON.stringify(c.selector)})];
    if (${JSON.stringify(c.text || '')}) els = els.filter((e) => (e.textContent || '').includes(${JSON.stringify(c.text || '')}) || (e.getAttribute('aria-label') || '').includes(${JSON.stringify(c.text || '')}));
    const el = els[${c.index || 0}];
    if (el) { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }
    if (Date.now() > end) throw new Error('not found: ' + ${JSON.stringify(JSON.stringify(c))});
    await new Promise((r) => setTimeout(r, 50));
  }
})()`;

/**
 * Keyboard focus needs real key input (a script's .focus() does not show :focus-visible): sends Tab key events with
 * sendInputEvent from the start of the page until the target has focus.
 */
async function focusByTab(wc, c) {
  // The window is offscreen and never focused: tell the page it has focus, or no focus ring is drawn.
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  wc.focus();
  await wc.executeJavaScript('document.activeElement && document.activeElement.blur(); true');
  for (let i = 0; i < 120; i++) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await sleep(40);
    if (await wc.executeJavaScript(focusedScript(c))) return;
  }
  throw new Error('focus not reached: ' + JSON.stringify(c));
}

/** Presses one key with real key events (Electron key codes: 'Down', 'Right', 'Home', 'Enter'). The page must have focus (see focusByTab). */
async function pressKey(wc, keyCode) {
  wc.sendInputEvent({ type: 'keyDown', keyCode });
  wc.sendInputEvent({ type: 'keyUp', keyCode });
  await sleep(80);
}

/** Moves the real mouse over an element (hover styles need it, a script cannot set :hover). */
async function hoverOver(wc, c) {
  const { x, y } = await wc.executeJavaScript(centreScript(c));
  wc.sendInputEvent({ type: 'mouseMove', x: x - 3, y: y - 3 });
  await sleep(60);
  wc.sendInputEvent({ type: 'mouseMove', x, y });
}

function isBlank(image) {
  const buf = image.toBitmap();
  if (buf.length < 4) return true;
  for (let i = 4; i < buf.length; i += 4) {
    if (buf[i] !== buf[0] || buf[i + 1] !== buf[1] || buf[i + 2] !== buf[2]) return false;
  }
  return true;
}

async function shoot(scene) {
  const win = new BrowserWindow({
    width: scene.width ?? WIDTH, height: scene.height ?? HEIGHT, show: false, backgroundColor: '#0F172A',
    webPreferences: {
      offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: false,
      preload: path.join(dist, 'shots', 'preload.js'),
      additionalArguments: [`--shots-scene=${scene.name}`],
    },
  });
  try {
    const wc = win.webContents;
    wc.setFrameRate(30);
    const errors = [];
    wc.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
    // localStorage (panel state) is shared by all windows of one run: start every scene clean.
    await win.webContents.session.clearStorageData({ storages: ['localstorage'] });
    await win.loadFile(path.join(dist, 'renderer', 'index.html'));
    if (reduced) {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    }
    await sleep(BOOT_MS);
    for (const step of scene.steps) {
      if (step.click) await wc.executeJavaScript(clickScript(step.click));
      else if (step.scroll) await wc.executeJavaScript(scrollScript(step.scroll));
      else if (step.emit) await wc.executeJavaScript(emitScript(step.emit));
      else if (step.waitFor) await wc.executeJavaScript(waitForScript(step.waitFor));
      else if (step.focus) await focusByTab(wc, step.focus);
      else if (step.hover) await hoverOver(wc, step.hover);
      else if (step.press) await pressKey(wc, step.press);
      else if (step.select) await wc.executeJavaScript(selectScript(step.select));
      else if (step.files) await wc.executeJavaScript(filesScript(step.files));
      else if (step.type) await wc.executeJavaScript(typeScript(step.type));
      else if (step.wait) await sleep(step.wait);
    }
    await sleep(scene.settleMs ?? SETTLE_MS);
    const image = await wc.capturePage();
    const size = image.getSize();
    if (size.width !== (scene.width ?? WIDTH) || size.height !== (scene.height ?? HEIGHT)) throw new Error(`unexpected size ${size.width}x${size.height}`);
    if (isBlank(image)) throw new Error('blank image (one colour)');
    // The shell never scrolls: the document must be exactly the window's height in every scene.
    const doc = await wc.executeJavaScript('({ scroll: document.scrollingElement.scrollHeight, inner: innerHeight })');
    if (doc.scroll > doc.inner) throw new Error(`the window scrolls: document ${doc.scroll} px in a ${doc.inner} px window`);
    const file = path.join(out, `${scene.name}${reduced ? '-reduced' : ''}.png`);
    fs.writeFileSync(file, image.toPNG());
    if (errors.length) console.warn(`  renderer errors in ${scene.name}: ${errors.join(' | ')}`);
    return file;
  } finally {
    win.destroy();
    await sleep(500); // let the renderer process go before the next window starts
  }
}

// Closing a scene's window must not quit the app: the next scene follows.
app.on('window-all-closed', () => undefined);

app.whenReady().then(async () => {
  let failed = 0;
  try {
    const { buildScenes } = require(path.join(dist, 'shots', 'scenes.cjs'));
    const wanted = (process.env.SHOTS_SCENES || '').split(',').filter(Boolean);
    const all = buildScenes();
    const unknown = wanted.filter((n) => !all.some((s) => s.name === n));
    if (unknown.length) throw new Error(`unknown scene(s): ${unknown.join(', ')}`);
    fs.mkdirSync(out, { recursive: true });
    for (const scene of all.filter((s) => wanted.length === 0 || wanted.includes(s.name))) {
      try {
        const file = await shoot(scene);
        console.log(`ok    ${scene.name} -> ${file}`);
      } catch (err) {
        failed += 1;
        console.error(`FAIL  ${scene.name}: ${err && err.message ? err.message : err}`);
      }
    }
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${err && err.message ? err.message : err}`);
  }
  app.exit(failed ? 1 : 0);
});
