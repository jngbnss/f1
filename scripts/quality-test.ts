/**
 * Quality tiers and the runtime governor (no browser):
 * 1. ?quality= forces a tier; desktops get 'high'; phones 'mid' or 'low' from the hardware;
 * 2. the tier sets the world's draw distance / crowd / car detail;
 * 3. the governor steps down (shadows, post-processing, draw distance) only after
 *    several slow windows at the lowest resolution, one step at a time, with a cooldown.
 *
 *   npx tsx scripts/quality-test.ts
 */
import type { DynamicResolution } from '../src/performance/DynamicResolution';
import type { PerfSnapshot } from '../src/performance/PerformanceMonitor';
import { detectTier, QUALITY, setQuality } from '../src/performance/Quality';
import { QualityGovernor } from '../src/performance/QualityGovernor';

let failures = 0;
function check(ok: boolean, message: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures++;
}

console.log('Tier detection');
check(detectTier('?quality=low', false) === 'low' && detectTier('?quality=mid', true) === 'mid', '?quality= forces the tier');
check(detectTier('', false) === 'high', 'desktop: high (unchanged game)');
const nav = globalThis.navigator as Navigator & { deviceMemory?: number };
const setHw = (cores: number, memory: number) => {
  Object.defineProperty(nav, 'hardwareConcurrency', { value: cores, configurable: true });
  Object.defineProperty(nav, 'deviceMemory', { value: memory, configurable: true });
};
setHw(8, 8);
check(detectTier('', true) === 'mid', 'phone with 8 cores / 8 GB: mid');
setHw(4, 4);
check(detectTier('', true) === 'low', 'phone with 4 cores: low');
setHw(8, 2);
check(detectTier('', true) === 'low', 'phone with 2 GB: low');

console.log('Tier profiles');
setQuality('high');
const high = { ...QUALITY };
setQuality('low');
check(QUALITY.viewDistance < high.viewDistance && QUALITY.crowd < high.crowd && QUALITY.carDetail < high.carDetail, `low: draw distance x${QUALITY.viewDistance}, crowd ${QUALITY.crowd * 100} %, car detail ${QUALITY.carDetail} m`);
check(high.viewDistance === 1 && high.crowd === 1 && high.carDetail === 70, 'high: everything as before');

console.log('Governor');
{
  const resolution = { atMinimum: false } as unknown as DynamicResolution;
  const taken: string[] = [];
  let shadows = true;
  const governor = new QualityGovernor(
    resolution,
    [() => (shadows ? ((shadows = false), 'shadows') : null), () => null, () => 'distance'],
    (label) => taken.push(label),
  );
  let window = 0;
  let now = 0;
  const frame = (ms: number) => {
    governor.update({ windowId: ++window, frameTimeAvg: ms } as PerfSnapshot, (now += 500));
  };
  for (let i = 0; i < 10; i++) frame(30);
  check(taken.length === 0, 'slow but resolution can still drop: no step');
  (resolution as { atMinimum: boolean }).atMinimum = true;
  frame(30);
  frame(30);
  check(taken.length === 0, 'two slow windows at minimum resolution: still waiting');
  frame(30);
  check(taken.join() === 'shadows', 'third slow window: shadows off');
  for (let i = 0; i < 6; i++) frame(30);
  check(taken.length === 1, 'cooldown after a step');
  for (let i = 0; i < 6; i++) frame(30);
  check(taken.join() === 'shadows,distance', 'next step skips one with nothing left to give');
  for (let i = 0; i < 20; i++) frame(30);
  check(taken.length === 2, 'no steps left: stays');
  const fast = new QualityGovernor(resolution, [() => 'x'], (l) => taken.push(l));
  for (let i = 0; i < 20; i++) fast.update({ windowId: 100 + i, frameTimeAvg: 12 } as PerfSnapshot, 20000 + i * 500);
  check(taken.length === 2, 'fast frames: nothing taken');
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
