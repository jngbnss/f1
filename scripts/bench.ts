/**
 * Runs the in-game benchmark (?bench) on every circuit in a real browser on
 * this machine and writes the results to docs/perf/.
 *
 *   npm run build && npm run bench              # 40 s per track, vsync off
 *   npm run bench -- --seconds 20 --label after-lod
 *   npm run bench -- --headed                   # visible window (closest to real play)
 *
 * Uses Chrome or Edge (BROWSER env var to override the path). The browser
 * runs with vsync / frame-rate limit off so fps above the monitor refresh
 * rate are visible.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BenchResult } from '../src/performance/Benchmark';

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const seconds = Number(arg('seconds', '40'));
const label = arg('label', 'baseline');
const headed = args.includes('--headed');
const port = 4179;

const BROWSERS = [
  process.env.BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter((p): p is string => !!p && existsSync(p));

function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      fetch(url)
        .then(() => resolve())
        .catch(() => (Date.now() - start > timeoutMs ? reject(new Error('preview server did not start')) : setTimeout(poll, 300)));
    };
    poll();
  });
}

async function main(): Promise<void> {
  if (!existsSync('dist/index.html')) throw new Error('dist/ missing: run `npm run build` first');
  const browser = BROWSERS[0];
  if (!browser) throw new Error('No Chrome/Edge found; set BROWSER=<path>');

  const server = spawn(`npx vite preview --port ${port} --strictPort`, { shell: true, stdio: 'ignore' });
  const profile = mkdtempSync(join(tmpdir(), 'web-sim-lab-bench-'));
  let chrome: ChildProcess | null = null;
  try {
    await waitForServer(`http://localhost:${port}/`, 20000);
    const url = `http://localhost:${port}/?bench=${seconds}`;
    chrome = spawn(
      browser,
      [
        ...(headed ? [] : ['--headless=new']),
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1920,1080',
        '--ignore-gpu-blocklist',
        '--disable-gpu-vsync',
        '--disable-frame-rate-limit',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--enable-logging=stderr',
        '--v=0',
        url,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    const results: BenchResult[] = [];
    const tracks = 17;
    const timeoutMs = tracks * (seconds + 60) * 1000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${results.length} result(s)`)), timeoutMs);
      let buf = '';
      chrome!.stderr!.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const m = line.match(/BENCH_RESULT (\{.*\})/);
          if (m) {
            const r = JSON.parse(m[1]) as BenchResult;
            results.push(r);
            console.log(`${r.track.padEnd(12)} avg ${r.fpsAvg} fps · 1% low ${r.fps1Low} · min ${r.fpsMin} · <90fps ${r.slowFramesPct}% · ${r.drawCallsAvg} calls`);
          }
          if (/BENCH_DONE/.test(line)) {
            clearTimeout(timer);
            resolve();
          }
          if (/Failed to start/.test(line)) reject(new Error(line));
        }
      });
      chrome!.on('exit', () => reject(new Error('browser exited early')));
    });

    mkdirSync('docs/perf', { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const base = `docs/perf/${day}-${label}`;
    writeFileSync(`${base}.json`, JSON.stringify(results, null, 2) + '\n');
    writeFileSync(`${base}.md`, report(results, label));
    console.log(`\nGPU: ${results[0]?.gpu}\nSaved ${base}.md / .json`);
  } finally {
    chrome?.kill();
    server.kill();
    if (process.platform === 'win32' && server.pid) spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 1500);
  }
}

function report(results: BenchResult[], name: string): string {
  const r0 = results[0];
  const lines = [
    `# Benchmark: ${name}`,
    '',
    `- Date: ${r0?.date ?? ''}`,
    `- GPU: ${r0?.gpu ?? ''}`,
    `- Resolution: ${r0?.resolution ?? ''} (pixel ratio ${r0?.pixelRatio ?? ''}), dynamic resolution off, vsync off`,
    `- Scene: ${r0?.car ?? ''} × ${r0?.cars ?? 0} cars (player on autopilot), ${r0?.seconds ?? 0} s per track after a ${3} s warmup`,
    '- Target: 90 fps minimum (frame time ≤ 11.1 ms)',
    '',
    '| Track | Avg fps | 1% low | Min fps | Frames < 90 fps | Physics ms | Render ms | Draw calls (avg/max) | Triangles (avg/max) | Heap MB | Load ms |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...results.map(
      (r) =>
        `| ${r.track} | ${r.fpsAvg} | ${r.fps1Low} | ${r.fpsMin} | ${r.slowFramesPct}% | ${r.physicsMsAvg} | ${r.renderMsAvg} | ${r.drawCallsAvg} / ${r.drawCallsMax} | ${fmt(r.trianglesAvg)} / ${fmt(r.trianglesMax)} | ${r.heapMB ?? '-'} | ${r.loadMs} |`,
    ),
    '',
  ];
  return lines.join('\n');
}

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}k`);

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
