// Electron main process of the screenshot harness. Never shows a window: every BrowserWindow is `show: false` and
// offscreen, and the Dock icon is hidden first thing. Started by shoot.mjs, which sets the environment:
//   SHOTS         output folder for the PNGs
//   SHOTS_DIST    folder with the built app (dist/) and the harness bundles (dist/shots/)
//   SHOTS_SCENES  comma-separated scene names (empty: all)
//   REDUCED=1     emulate prefers-reduced-motion: reduce (files get a "-reduced" suffix)
//   SHOTS_SCALE   device scale factor (default 1; the shared media screenshots use 2). An offscreen window ignores the
//                 Chromium scale switch, so a scale above 1 is set with the DevTools device metrics override and the
//                 frames are taken with Page.captureScreenshot (see grab).
//   SHOTS_FRAMES=1  scenes with a `record` setting write raw frames (15 fps) instead of one PNG; see recordScene
//   (the encoder that turns them into GIF and MP4 is encode.mjs)
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.dock?.hide();
const SCALE = Number(process.env.SHOTS_SCALE || '1');
if (!(SCALE >= 1 && SCALE <= 3)) throw new Error('SHOTS_SCALE must be a number from 1 to 3');
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
const framesMode = process.env.SHOTS_FRAMES === '1';

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
const emitScript = (event) => {
  // A string '@now' or '@now-<ms>' in the event becomes that time (ISO) at the moment the step runs.
  const json = JSON.stringify(event, (_k, v) => {
    const m = typeof v === 'string' ? /^@now(?:-(\d+))?$/.exec(v) : null;
    return m ? new Date(Date.now() - Number(m[1] || 0)).toISOString() : v;
  });
  return `(() => { window.coa.emit(${json}); return true; })()`;
};

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

/**
 * An offscreen window draws no mouse pointer. A scene with a `record` setting gets a drawn one (an arrow in a fixed,
 * click-through element) that glides to wherever `hover` and `click` steps go, so a recorded sequence shows where the user acts.
 */
const cursorInstallScript = (x, y) => `(() => {
  if (document.getElementById('shots-cursor')) return true;
  const el = document.createElement('div');
  el.id = 'shots-cursor';
  el.style.cssText = 'position:fixed;left:0;top:0;width:20px;height:28px;z-index:2147483647;pointer-events:none;transform:translate(${x}px,${y}px);transition:transform 450ms cubic-bezier(.4,0,.2,1);';
  el.innerHTML = '<svg width="20" height="28" viewBox="0 0 20 28" xmlns="http://www.w3.org/2000/svg"><path id="shots-cursor-arrow" d="M2 2 L2 22 L7 17.5 L10.5 25.5 L13.5 24.2 L10 16.3 L16.5 16.3 Z" fill="#fff" stroke="#0F172A" stroke-width="1.6" stroke-linejoin="round" style="transform-origin:2px 2px;transition:transform 120ms"/></svg>';
  document.body.appendChild(el);
  return true;
})()`;
const cursorMoveScript = (x, y) => `(() => { const e = document.getElementById('shots-cursor'); if (e) e.style.transform = 'translate(${x}px,${y}px)'; return true; })()`;
const cursorPressScript = `(() => { const a = document.getElementById('shots-cursor-arrow'); if (a) { a.style.transform = 'scale(.82)'; setTimeout(() => { a.style.transform = ''; }, 160); } return true; })()`;

/** Moves the real mouse over an element (hover styles need it, a script cannot set :hover). */
async function hoverOver(wc, c) {
  const { x, y } = await wc.executeJavaScript(centreScript(c));
  wc.executeJavaScript(cursorMoveScript(x, y)).catch(() => undefined);
  wc.sendInputEvent({ type: 'mouseMove', x: x - 3, y: y - 3 });
  await sleep(60);
  wc.sendInputEvent({ type: 'mouseMove', x, y });
}

/** One frame of the window as a NativeImage, at SCALE device pixels per CSS pixel (capturePage always returns 1x). */
async function grab(wc) {
  if (SCALE === 1) return wc.capturePage();
  const shot = await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png' });
  return nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
}

function isBlank(image) {
  const buf = image.toBitmap();
  if (buf.length < 4) return true;
  for (let i = 4; i < buf.length; i += 4) {
    if (buf[i] !== buf[0] || buf[i + 1] !== buf[1] || buf[i + 2] !== buf[2]) return false;
  }
  return true;
}

/** Runs one scene step in the page (see the Step type in scenes.ts). */
async function runStep(wc, step) {
  if (step.click) {
    wc.executeJavaScript(cursorPressScript).catch(() => undefined);
    await wc.executeJavaScript(clickScript(step.click));
  }
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

/** Plays a scene's timeline in real time: each step starts at its `at` (ms after t0, the first frame). */
async function playTimeline(wc, timeline, t0) {
  for (const { at, step } of [...timeline].sort((a, b) => a.at - b.at)) {
    const wait = t0 + at - Date.now();
    if (wait > 0) await sleep(wait);
    await runStep(wc, step);
  }
}

/**
 * Records a scene with a `record` setting: frames are captured as fast as the offscreen window allows while the timeline
 * plays, stored raw (BGRA), then one frame is picked for every tick of `fps` (the latest one captured at or before the tick).
 * Writes <out>/<name>.frames/<n>.bgra and <out>/<name>.frames/frames.json (size, fps, the frame index of every output frame).
 */
async function recordScene(wc, scene, width, height) {
  const dir = path.join(out, `${scene.name}.frames`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const { fps, durationMs } = scene.record;
  const stamps = [];
  const t0 = Date.now();
  let stop = false;
  const capture = (async () => {
    while (!stop) {
      const at = Date.now() - t0;
      const image = await grab(wc);
      const size = image.getSize();
      if (size.width !== width || size.height !== height) throw new Error(`unexpected frame size ${size.width}x${size.height}`);
      fs.writeFileSync(path.join(dir, `${stamps.length}.bgra`), image.toBitmap());
      stamps.push(at);
    }
  })();
  const play = playTimeline(wc, scene.timeline ?? [], t0);
  await sleep(durationMs);
  stop = true;
  await Promise.all([capture, play]);
  const sequence = [];
  for (let k = 0; k * (1000 / fps) < durationMs; k++) {
    const tick = k * (1000 / fps);
    let pick = 0;
    for (let i = 0; i < stamps.length; i++) if (stamps[i] <= tick) pick = i;
    sequence.push(pick);
  }
  fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify({ width, height, fps, sequence, captured: stamps.length }));
  return dir;
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
    if (SCALE > 1) {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: scene.width ?? WIDTH, height: scene.height ?? HEIGHT, deviceScaleFactor: SCALE, mobile: false });
    }
    await sleep(BOOT_MS);
    if (scene.record) await wc.executeJavaScript(cursorInstallScript(...(scene.record.cursorStart ?? [1260, 800])));
    const width = scene.width ?? WIDTH;
    const height = scene.height ?? HEIGHT;
    for (const step of scene.steps) await runStep(wc, step);
    // A scene with a `record` setting: the first state is what the sequence starts from, the timeline plays in real time.
    if (scene.record && framesMode) {
      const dir = await recordScene(wc, scene, Math.round(width * SCALE), Math.round(height * SCALE));
      if (errors.length) console.warn(`  renderer errors in ${scene.name}: ${errors.join(' | ')}`);
      return dir;
    }
    if (scene.record) {
      // Not recording: a PNG of the first state (<name>-first.png) and, after the timeline, of the last (<name>.png).
      const first = await grab(wc);
      fs.writeFileSync(path.join(out, `${scene.name}-first.png`), first.toPNG());
      const t0 = Date.now();
      await playTimeline(wc, scene.timeline ?? [], t0);
      await sleep(Math.max(0, t0 + scene.record.durationMs - Date.now()));
    } else {
      await sleep(scene.settleMs ?? SETTLE_MS);
    }
    const image = await grab(wc);
    const size = image.getSize();
    if (size.width !== Math.round(width * SCALE) || size.height !== Math.round(height * SCALE)) throw new Error(`unexpected size ${size.width}x${size.height}`);
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
