import { getGameVolume, onGameVolume, setGameVolume } from '../audio/AudioSystem';

/**
 * Game sound volume: a small 🔊 button (bottom centre on desktop) that opens
 * a slider. Touch screens get the same slider inside the settings panel
 * instead (see TouchControls), so this widget is desktop only. M still mutes.
 */
export function mountVolumeControl(): () => void {
  const root = document.createElement('div');
  root.className = 'volume-ctl';
  root.innerHTML = `<button type="button" aria-label="게임 소리">🔊</button><input type="range" min="0" max="100" step="5" aria-label="게임 소리 크기"><span></span>`;
  const btn = root.querySelector('button')!;
  const slider = root.querySelector('input')!;
  const label = root.querySelector('span')!;
  const show = (v: number) => {
    slider.value = String(Math.round(v * 100));
    label.textContent = `${Math.round(v * 100)}%`;
    btn.textContent = v === 0 ? '🔇' : v < 0.4 ? '🔈' : '🔊';
  };
  show(getGameVolume());
  btn.addEventListener('click', () => root.classList.toggle('open'));
  slider.addEventListener('input', () => setGameVolume(Number(slider.value) / 100));
  // Keep keyboard driving keys working after using the slider.
  slider.addEventListener('change', () => slider.blur());
  const off = onGameVolume(show);
  document.body.appendChild(root);
  return () => {
    off();
    root.remove();
  };
}

/** Slider row for the touch settings panel. */
export function volumeRow(): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'tc-row';
  row.innerHTML = `<span>게임 소리</span><input type="range" min="0" max="100" step="5" style="flex:1;max-width:220px">`;
  const slider = row.querySelector('input')!;
  slider.value = String(Math.round(getGameVolume() * 100));
  slider.addEventListener('input', () => setGameVolume(Number(slider.value) / 100));
  return row;
}
