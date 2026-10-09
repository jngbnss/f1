/**
 * Screenshots of the built game in a real browser (visual checks without
 * playing). The player is on autopilot (?bench), so shots are mid-race.
 *
 *   npm run build && npx tsx scripts/shot.ts [track | track@car ...] [--wait 12] [--out shots] [--query "&ai=0"]
 *
 * Writes <out>/<track>.png (1600x900). Uses Chrome or Edge (BROWSER env var to override).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = argv[i + 1] ?? fallback;
  argv.splice(i, 2);
  return v;
};
const wait = Number(opt('wait', '12'));
const out = opt('out', 'shots');
const query = opt('query', '');
/** JS expression evaluated in the page right after each screenshot (printed as JSON); needs window.sim (dev or ?bench). */
const evalArg = opt('eval', '');
const evalExpr = evalArg.startsWith('@') ? readFileSync(evalArg.slice(1), 'utf8').trim().replace(/;$/, '') : evalArg;
/** JS run `--lead` seconds before the screenshot (needs window.sim: ?bench), e.g. to place the player. */
const preArg = opt('pre', '');
const preExpr = preArg.startsWith('@') ? readFileSync(preArg.slice(1), 'utf8') : preArg;
const preLead = Number(opt('lead', '1.5'));
const tracks = argv.length ? argv : ['test', 'spielberg', 'monza', 'silverstone', 'spa'];
const port = Number(process.env.SHOT_PORT ?? 4180);
const cdpPort = Number(process.env.CDP_PORT ?? 9333);

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

/** Minimal Chrome DevTools Protocol client over the built-in WebSocket. */
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
  const profile = mkdtempSync(join(tmpdir(), 'web-sim-lab-shot-'));
  const chrome = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--window-size=1600,900',
    '--ignore-gpu-blocklist',
    'about:blank',
  ]);
  try {
    await waitFor(`http://localhost:${port}/`);
    const targets = (await (await waitFor(`http://127.0.0.1:${cdpPort}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target');
    const cdp = await connect(page.webSocketDebuggerUrl);
    for (const entry of tracks) {
      const [track, car] = entry.split('@');
      await cdp.send('Page.navigate', { url: `http://localhost:${port}/?bench=999&track=${track}${car ? `&car=${car}` : ''}${query}` });
      if (preExpr) {
        // e.g. teleport the player somewhere, then let it settle before the shot.
        await sleep(Math.max(wait - preLead, 0) * 1000);
        const r = await cdp.send('Runtime.evaluate', { expression: preExpr, returnByValue: true });
        if (r.result && (r.result as { exceptionDetails?: unknown }).exceptionDetails) console.log(JSON.stringify(r.result));
        await sleep(Math.min(preLead, wait) * 1000);
      } else await sleep(wait * 1000);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = join(out, `${entry.replace('@', '_')}.png`);
      writeFileSync(file, Buffer.from(String(shot.result?.data ?? ''), 'base64'));
      console.log(`saved ${file}`);
      if (evalExpr) {
        const r = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify(${evalExpr})`, returnByValue: true });
        console.log(JSON.stringify(r.result));
      }
    }
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
