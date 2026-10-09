/**
 * Multiplayer smoke test: one headless Chrome, N windows. Window 1 creates a
 * room from the menu, the others join with ?room=CODE, the host starts the
 * race, every window holds the throttle, and each window must see every car
 * (its own and the remote ones) moving. Screenshots of every window.
 *
 *   npm run build && npx tsx scripts/mp-test.ts [--players 3] [--ai] [--out shots/mp]
 *
 * Needs internet: signalling goes through the public PeerJS broker.
 * Ports: SHOT_PORT (default 4210) for vite preview, CDP_PORT (default 9360).
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
const players = Number(opt('players', '3'));
const withAi = argv.includes('--ai');
const out = opt('out', 'shots/mp');
const port = Number(process.env.SHOT_PORT ?? 4210);
const cdpPort = Number(process.env.CDP_PORT ?? 9360);
const base = `http://localhost:${port}/`;

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

type Cdp = Awaited<ReturnType<typeof connect>>;

async function connect(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map<number, (v: { result?: Record<string, unknown>; error?: unknown }) => void>();
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data)) as { id?: number; result?: Record<string, unknown> };
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  };
  const send = (method: string, params: object = {}) =>
    new Promise<{ result?: Record<string, unknown>; error?: unknown }>((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  /** Evaluates an expression (awaits promises) and returns its JSON value. */
  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const res = r.result as { result?: { value?: T }; exceptionDetails?: unknown } | undefined;
    if (res?.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(res.exceptionDetails).slice(0, 300)}`);
    return res?.result?.value as T;
  };
  return { send, evaluate, close: () => ws.close() };
}

/** Polls `expression` until truthy (returns its value) or fails after `ms`. */
async function until<T>(cdp: Cdp, expression: string, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cdp.evaluate<T>(expression).catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(300);
  }
}

const key = (cdp: Cdp, type: 'keyDown' | 'keyUp') =>
  cdp.send('Input.dispatchKeyEvent', { type, code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });

async function main(): Promise<void> {
  if (!existsSync('dist/index.html')) throw new Error('dist/ missing: run `npm run build` first');
  if (!browser) throw new Error('No Chrome/Edge found; set BROWSER=<path>');
  mkdirSync(out, { recursive: true });
  const server = spawn(`npx vite preview --port ${port} --strictPort`, { shell: true, stdio: 'ignore' });
  const profile = mkdtempSync(join(tmpdir(), 'web-sim-lab-mp-'));
  const chrome = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--window-size=960,540',
    '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    'about:blank',
  ]);
  const tabs: Cdp[] = [];
  let failed = false;
  try {
    await waitFor(base);
    const version = (await (await waitFor(`http://127.0.0.1:${cdpPort}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const root = await connect(version.webSocketDebuggerUrl);
    for (let i = 0; i < players; i++) {
      const t = await root.send('Target.createTarget', { url: 'about:blank', newWindow: true });
      const targetId = String(t.result?.targetId);
      tabs.push(await connect(`ws://127.0.0.1:${cdpPort}/devtools/page/${targetId}`));
    }
    const q = '&sound=0&forest=0';

    // --- host creates the room from the menu -------------------------------
    const host = tabs[0];
    await host.send('Page.navigate', { url: `${base}?menu${q}` });
    await until(host, `!!document.querySelector('.menu-mp')`, 20000, 'menu');
    await host.evaluate(`localStorage.setItem('mp-name', 'Host'); document.querySelector('.menu-mp').click(); true`);
    await until(host, `!!document.querySelector('.lobby [data-part="main"]')`, 10000, 'lobby');
    await host.evaluate(`document.querySelector('.lobby [data-part="main"]').click(); true`);
    const code = await until<string>(host, `document.querySelector('.lobby-code')?.textContent || (document.querySelector('.lobby-status.error')?.textContent ? 'ERR:' + document.querySelector('.lobby-status.error').textContent : '')`, 30000, 'room code');
    if (code.startsWith('ERR:')) throw new Error(`room creation failed: ${code.slice(4)}`);
    console.log(`room ${code}`);

    // --- the others join via the link ---------------------------------------
    for (let i = 1; i < tabs.length; i++) {
      const tab = tabs[i];
      await tab.send('Page.navigate', { url: `${base}?room=${code}${q}` });
      await until(tab, `!!document.querySelector('.lobby [data-part="main"]')`, 20000, `lobby ${i}`);
      // The remembered name auto-joins; rename after joining.
      await tab.evaluate(`(() => { const b = document.querySelector('.lobby [data-part="main"]'); if (!b.disabled && !document.querySelector('.lobby-code')) b.click(); return true; })()`);
      await until(tab, `!!document.querySelector('.lobby-code')`, 30000, `join ${i}`);
      await tab.evaluate(`(() => { const n = document.querySelector('.lobby-name'); n.value = 'P${i + 1}'; n.dispatchEvent(new Event('input')); return true; })()`);
    }
    await until(host, `document.querySelectorAll('.lobby-players li').length === ${players}`, 20000, 'all players in lobby');
    console.log(`lobby: ${players} players`);
    await sleep(800);
    if (!withAi) await host.evaluate(`[...document.querySelectorAll('.lobby .menu-card')].find((b) => b.textContent.includes('사람끼리만')).click(); true`);
    await sleep(500);
    await host.evaluate(`document.querySelector('.lobby [data-part="main"]').click(); true`);

    // --- race: wait for the green light everywhere, then drive ---------------
    for (const [i, tab] of tabs.entries()) await until(tab, `window.sim?.race?.state === 'racing'`, 90000, `green light in window ${i + 1}`);
    console.log('green light in every window');
    const t0 = await Promise.all(tabs.map((t) => t.evaluate<number>(`performance.now()`)));
    console.log('clock (ms) per window at green:', t0.map((t) => Math.round(t)).join(', '));
    for (const tab of tabs) await key(tab, 'keyDown');
    const sample = () =>
      Promise.all(tabs.map((t) => t.evaluate<[string, number, number][]>(`window.sim.race.racers.map((r) => [r.name, r.vehicle.position.x, r.vehicle.position.z])`)));
    await sleep(1500);
    const a = await sample();
    for (let s = 0; s < 22; s++) {
      await sleep(1000);
      for (const tab of tabs) await key(tab, 'keyDown'); // re-press in case a window lost focus
    }
    const b = await sample();
    for (const [i, tab] of tabs.entries()) {
      const shot = await tab.send('Page.captureScreenshot', { format: 'png' });
      const file = join(out, `window${i + 1}.png`);
      writeFileSync(file, Buffer.from(String(shot.result?.data ?? ''), 'base64'));
      console.log(`saved ${file}`);
    }
    for (let i = 0; i < tabs.length; i++) {
      const moved = a[i].map(([name, x, z], k) => [name, Math.hypot(b[i][k][1] - x, b[i][k][2] - z)] as const);
      console.log(`window ${i + 1} sees ${moved.length} cars: ${moved.map(([n, d]) => `${n} ${d.toFixed(0)} m`).join(' · ')}`);
      if (moved.length !== (withAi ? 20 : players)) failed = true;
      if (moved.some(([, d]) => d < 10)) failed = true;
      const left = await tabs[i].evaluate<string>(`[...document.querySelectorAll('.net-banner')].map((e) => e.textContent).join('|')`);
      if (moved.some(([n]) => String(n).includes('(나감)')) || /끊어|시간 초과|닫았/.test(left)) {
        console.log(`window ${i + 1}: unexpected disconnect: ${left}`);
        failed = true;
      }
    }
    // Same car, two windows: positions should agree within the interpolation delay (~110 ms at speed).
    const hostView = Object.fromEntries(b[0].map(([n, x, z]) => [n, [x, z]]));
    for (let i = 1; i < tabs.length; i++) {
      const own = b[i].find(([n]) => n === `P${i + 1}`);
      const seen = own && hostView[own[0]];
      if (own && seen) console.log(`P${i + 1}: own vs host view ${Math.hypot(own[1] - seen[0], own[2] - seen[1]).toFixed(1)} m apart (sampled ~sequentially)`);
    }
    for (const tab of tabs) await key(tab, 'keyUp');
    // A player leaves mid-race: their car must disappear for everyone else.
    if (tabs.length > 2) {
      const leaver = tabs.pop()!;
      await leaver.send('Page.navigate', { url: 'about:blank' });
      leaver.close();
      const gone = `P${players} (나감)`;
      await until(host, `window.sim.race.racers.some((r) => r.name === '${gone}' && !r.vehicle.object3D.visible)`, 25000, 'leaver removed on host');
      await until(tabs[1], `window.sim.race.racers.some((r) => r.name === '${gone}')`, 25000, 'leaver removed on other client');
      console.log(`P${players} left: removed in the other windows`);
    }
    console.log(failed ? 'MP FAILED' : 'MP OK');
    root.close();
  } finally {
    for (const t of tabs) t.close();
    chrome.kill();
    server.kill();
    if (process.platform === 'win32' && server.pid) spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 1500);
  }
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
