/**
 * Phone screenshots of the built game: Chrome emulates a phone (viewport,
 * touch, mobile user agent), so the mobile preset, touch controls and the
 * responsive HUD/menu are what gets captured.
 *
 *   npm run build && npx tsx scripts/shot-mobile.ts [--out shots-mobile] [--portrait] [--wait 14]
 *
 * Shots: menu.png, race.png, braking.png (holding the brake button), pause.png.
 * Ports: SHOT_PORT / CDP_PORT env vars (defaults 4190 / 9340).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : (argv[i + 1] ?? fallback);
};
const portrait = argv.includes('--portrait');
const out = opt('out', 'shots-mobile');
const wait = Number(opt('wait', '14'));
const query = opt('query', '');
const port = Number(process.env.SHOT_PORT ?? 4190);
const cdpPort = Number(process.env.CDP_PORT ?? 9340);
// iPhone 14-ish: 844 x 390 CSS px landscape, DPR 3.
const W = portrait ? 390 : 844;
const H = portrait ? 844 : 390;
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

const browser = [
  process.env.BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find((p): p is string => !!p && existsSync(p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url: string): Promise<Response> {
  for (let i = 0; i < 100; i++) {
    try {
      return await fetch(url);
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`no response from ${url}`);
}

async function connect(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map<number, (v: { result?: Record<string, unknown> }) => void>();
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data)) as { id?: number; result?: Record<string, unknown> };
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  };
  return {
    send: (method: string, params: object = {}) =>
      new Promise<{ result?: Record<string, unknown> }>((resolve) => {
        const n = ++id;
        pending.set(n, resolve);
        ws.send(JSON.stringify({ id: n, method, params }));
      }),
    close: () => ws.close(),
  };
}

async function main(): Promise<void> {
  if (!existsSync('dist/index.html')) throw new Error('dist/ missing: run `npm run build` first');
  if (!browser) throw new Error('No Chrome/Edge found; set BROWSER=<path>');
  mkdirSync(out, { recursive: true });
  const server = spawn(`npx vite preview --port ${port} --strictPort`, { shell: true, stdio: 'ignore' });
  const profile = mkdtempSync(join(tmpdir(), 'web-sim-lab-mshot-'));
  const chrome = spawn(browser, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--ignore-gpu-blocklist', 'about:blank']);
  try {
    await waitFor(`http://localhost:${port}/`);
    const targets = (await (await waitFor(`http://127.0.0.1:${cdpPort}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target');
    const cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W,
      height: H,
      deviceScaleFactor: 3,
      mobile: true,
      screenWidth: W,
      screenHeight: H,
      screenOrientation: portrait ? { type: 'portraitPrimary', angle: 0 } : { type: 'landscapePrimary', angle: 90 },
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Android' });
    const shot = async (name: string) => {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = join(out, `${name}.png`);
      writeFileSync(file, Buffer.from(String(r.result?.data ?? ''), 'base64'));
      console.log(`saved ${file}`);
    };
    const touch = (type: 'touchStart' | 'touchEnd', x: number, y: number) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });

    await cdp.send('Page.navigate', { url: `http://localhost:${port}/?menu${query}` });
    await sleep(3000);
    await shot('menu');

    await cdp.send('Page.navigate', { url: `http://localhost:${port}/?car=f1-ferrari&track=monza&ai=19&laps=3${query}` });
    await sleep(wait * 1000);
    await shot('race');
    // Hold the brake pedal (bottom-right) for a moment.
    await touch('touchStart', W - 78, H - 70);
    await sleep(700);
    await shot('braking');
    await touch('touchEnd', W - 78, H - 70);
    await sleep(300);
    // Pause button: first in the top-left bar.
    await touch('touchStart', 28, 28);
    await touch('touchEnd', 28, 28);
    await sleep(500);
    await shot('pause');
    const r = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({ touch: document.body.classList.contains('touch'), pr: window.devicePixelRatio, canvas: [document.querySelector('canvas')?.width, document.querySelector('canvas')?.height] })`,
      returnByValue: true,
    });
    console.log(JSON.stringify(r.result));
    cdp.close();
  } finally {
    chrome.kill();
    server.kill();
    if (process.platform === 'win32' && server.pid) spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 1500);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
