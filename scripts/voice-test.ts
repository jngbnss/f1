/**
 * Voice chat test: one headless Chrome with fake microphones, N windows in
 * one room. Every window turns voice on; then one player holds push-to-talk
 * (V) and the others must receive their audio (analyser level > 0), show the
 * 🎙️ marker, and stop showing it after release. Repeated in the race, where
 * the marker must appear in the timing tower.
 *
 *   npm run build && npx tsx scripts/voice-test.ts [--players 3] [--out shots/voice]
 *
 * Needs internet (public PeerJS broker). Ports: SHOT_PORT (4220), CDP_PORT (9370).
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
const out = opt('out', 'shots/voice');
const port = Number(process.env.SHOT_PORT ?? 4220);
const cdpPort = Number(process.env.CDP_PORT ?? 9370);
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
  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const res = r.result as { result?: { value?: T }; exceptionDetails?: unknown } | undefined;
    if (res?.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(res.exceptionDetails).slice(0, 300)}`);
    return res?.result?.value as T;
  };
  return { send, evaluate, close: () => ws.close() };
}

async function until<T>(cdp: Cdp, expression: string, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cdp.evaluate<T>(expression).catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(250);
  }
}

const vKey = (cdp: Cdp, type: 'keyDown' | 'keyUp') =>
  cdp.send('Input.dispatchKeyEvent', { type, code: 'KeyV', key: 'v', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86 });

/** Max level of `id`'s voice seen in `tab` over `ms` (the fake mic beeps, so sample a while). */
async function peakLevel(tab: Cdp, id: string, ms: number): Promise<number> {
  return tab.evaluate<number>(`new Promise((res) => { let m = 0; const t0 = performance.now(); const f = () => { m = Math.max(m, window.netRoom.voice.level(${JSON.stringify(id)})); if (performance.now() - t0 < ${ms}) setTimeout(f, 20); else res(m); }; f(); })`);
}

async function main(): Promise<void> {
  if (!existsSync('dist/index.html')) throw new Error('dist/ missing: run `npm run build` first');
  if (!browser) throw new Error('No Chrome/Edge found; set BROWSER=<path>');
  mkdirSync(out, { recursive: true });
  const server = spawn(`npx vite preview --port ${port} --strictPort`, { shell: true, stdio: 'ignore' });
  const profile = mkdtempSync(join(tmpdir(), 'web-sim-lab-voice-'));
  const chrome = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--window-size=960,540',
    '--ignore-gpu-blocklist',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    'about:blank',
  ]);
  const tabs: Cdp[] = [];
  let failed = false;
  const check = (ok: boolean, what: string) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) failed = true;
  };
  try {
    await waitFor(base);
    const version = (await (await waitFor(`http://127.0.0.1:${cdpPort}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const root = await connect(version.webSocketDebuggerUrl);
    for (let i = 0; i < players; i++) {
      const t = await root.send('Target.createTarget', { url: 'about:blank', newWindow: true });
      tabs.push(await connect(`ws://127.0.0.1:${cdpPort}/devtools/page/${String(t.result?.targetId)}`));
    }
    const q = '&sound=0&forest=0';

    // --- room with everyone ------------------------------------------------------
    const host = tabs[0];
    await host.send('Page.navigate', { url: `${base}?menu${q}` });
    await until(host, `!!document.querySelector('.menu-mp')`, 20000, 'menu');
    await host.evaluate(`localStorage.setItem('mp-name', 'Host'); document.querySelector('.menu-mp').click(); true`);
    await until(host, `!!document.querySelector('.lobby [data-part="main"]')`, 10000, 'lobby');
    await host.evaluate(`document.querySelector('.lobby [data-part="main"]').click(); true`);
    const code = await until<string>(host, `document.querySelector('.lobby-code')?.textContent || (document.querySelector('.lobby-status.error')?.textContent ? 'ERR:' + document.querySelector('.lobby-status.error').textContent : '')`, 30000, 'room code');
    if (code.startsWith('ERR:')) throw new Error(`room creation failed: ${code.slice(4)}`);
    console.log(`room ${code}`);
    for (let i = 1; i < tabs.length; i++) {
      const tab = tabs[i];
      await tab.send('Page.navigate', { url: `${base}?room=${code}${q}` });
      await until(tab, `!!document.querySelector('.lobby [data-part="main"]')`, 20000, `lobby ${i}`);
      await tab.evaluate(`(() => { const b = document.querySelector('.lobby [data-part="main"]'); if (!b.disabled && !document.querySelector('.lobby-code')) b.click(); return true; })()`);
      await until(tab, `!!document.querySelector('.lobby-code')`, 30000, `join ${i}`);
      await tab.evaluate(`(() => { const n = document.querySelector('.lobby-name'); n.value = 'P${i + 1}'; n.dispatchEvent(new Event('input')); return true; })()`);
    }
    await until(host, `document.querySelectorAll('.lobby-players li').length === ${players}`, 20000, 'all players in lobby');
    const ids = await Promise.all(tabs.map((t) => t.evaluate<string>('window.netRoom.myId')));
    console.log(`lobby: ${players} players`);

    // --- everyone turns voice on (fake mic, auto-allowed) -------------------------
    for (const tab of tabs) {
      await tab.evaluate(`[...document.querySelectorAll('.voice-btn')].find((b) => b.textContent.includes('음성 채팅 켜기')).click(); true`);
    }
    for (const [i, tab] of tabs.entries()) {
      await until(tab, `window.netRoom.voice.micOn`, 15000, `mic on in window ${i + 1}`);
      const others = ids.filter((_, k) => k !== i);
      await until(tab, `${JSON.stringify(others)}.every((id) => window.netRoom.voice.connected(id))`, 30000, `audio from everyone in window ${i + 1}`);
    }
    console.log('voice mesh connected (every window receives every other window)');

    // --- push-to-talk in the lobby -------------------------------------------------
    const talker = 1;
    const quiet = await peakLevel(tabs[0], ids[talker], 1500);
    check(quiet < 0.003, `P${talker + 1} silent before PTT (peak ${quiet.toFixed(4)})`);
    await vKey(tabs[talker], 'keyDown');
    check(await tabs[talker].evaluate<boolean>('window.netRoom.voice.transmittingNow'), 'talker is transmitting while V is held');
    for (const [i, tab] of tabs.entries()) {
      if (i === talker) continue;
      const peak = await peakLevel(tab, ids[talker], 2500);
      check(peak > 0.005, `window ${i + 1} hears P${talker + 1} (peak ${peak.toFixed(4)})`);
      const marker = await until<boolean>(tab, `!!document.querySelector('.voice-mic.on[data-voice-id="${ids[talker]}"]')`, 4000, 'lobby marker').catch(() => false);
      check(marker, `window ${i + 1} shows 🎙️ for P${talker + 1} in the lobby`);
    }
    const shot = await tabs[0].send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(out, 'lobby.png'), Buffer.from(String(shot.result?.data ?? ''), 'base64'));
    await vKey(tabs[talker], 'keyUp');
    await sleep(1200);
    const after = await peakLevel(tabs[0], ids[talker], 1500);
    check(after < 0.003, `P${talker + 1} silent after release (peak ${after.toFixed(4)})`);
    check(!(await tabs[0].evaluate<boolean>(`window.netRoom.voice.isSpeaking(${JSON.stringify(ids[talker])})`)), 'marker off after release');

    // --- in the race: tower marker ---------------------------------------------------
    await host.evaluate(`[...document.querySelectorAll('.lobby .menu-card')].find((b) => b.textContent.includes('사람끼리만')).click(); true`);
    await sleep(500);
    await host.evaluate(`document.querySelector('.lobby [data-part="main"]').click(); true`);
    for (const [i, tab] of tabs.entries()) await until(tab, `window.sim?.race?.state === 'racing'`, 90000, `green light in window ${i + 1}`);
    console.log('race started');
    const raceTalker = players - 1;
    await vKey(tabs[raceTalker], 'keyDown');
    const tower = await until<boolean>(host, `window.sim.race.racers.some((r) => r.name === 'P${raceTalker + 1} 🎙️')`, 6000, 'tower marker').catch(() => false);
    check(tower, `host's timing tower shows "P${raceTalker + 1} 🎙️" while they talk`);
    const talkerChip = await host.evaluate<string>(`[...document.querySelectorAll('.voice-talker')].map((e) => e.textContent).join('|')`);
    check(talkerChip.includes(`P${raceTalker + 1}`), `host's overlay lists the talker (${talkerChip || 'none'})`);
    for (const [i, tab] of tabs.entries()) {
      const s = await tab.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(out, `race${i + 1}.png`), Buffer.from(String(s.result?.data ?? ''), 'base64'));
    }
    await vKey(tabs[raceTalker], 'keyUp');
    await sleep(1200);
    check(!(await host.evaluate<boolean>(`window.sim.race.racers.some((r) => r.name.includes('🎙️'))`)), 'tower marker gone after release');

    // --- a player leaves: their voice is dropped -------------------------------------
    const leaver = tabs.pop()!;
    await leaver.send('Page.navigate', { url: 'about:blank' });
    leaver.close();
    const gone = await until<boolean>(host, `!window.netRoom.voice.connected(${JSON.stringify(ids[players - 1])})`, 25000, 'leaver voice dropped').catch(() => false);
    check(gone, 'leaver voice dropped on host');
    console.log(failed ? 'VOICE FAILED' : 'VOICE OK');
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
