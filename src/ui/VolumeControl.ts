import { getGameVolume, onGameVolume, setGameVolume } from '../audio/AudioSystem';
import { onRadioSettings, readRadioSettings, saveRadioSettings, type RadioSettings } from '../audio/TeamRadio';

/**
 * Sound settings: a small 🔊 button (bottom centre on desktop) that opens a
 * panel with the engine / effects volume and the team radio (on/off, its own
 * volume, voice language, subtitles). Touch screens get the same rows inside
 * the settings panel instead (see TouchControls). M still mutes.
 */
export function mountVolumeControl(): () => void {
  const root = document.createElement('div');
  root.className = 'volume-ctl';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-label', '소리 설정');
  const panel = document.createElement('div');
  panel.className = 'volume-panel';
  const rows = soundRows();
  panel.append(...rows.elements);
  root.append(btn, panel);
  const icon = (v: number) => {
    btn.textContent = v === 0 ? '🔇' : v < 0.4 ? '🔈' : '🔊';
  };
  icon(getGameVolume());
  btn.addEventListener('click', () => root.classList.toggle('open'));
  const off = onGameVolume(icon);
  document.body.appendChild(root);
  return () => {
    off();
    rows.dispose();
    root.remove();
  };
}

/** Rows for the touch settings panel (same controls as the desktop panel). */
export function volumeRow(): HTMLDivElement {
  const wrap = document.createElement('div');
  // The touch panel is rebuilt each time it opens: drop the listeners once these rows are gone.
  const rows = soundRows('tc-row', () => wrap.isConnected);
  wrap.append(...rows.elements);
  return wrap;
}

/** Engine / effects volume + team radio settings, kept in sync with changes made elsewhere. */
function soundRows(rowClass = 'vp-row', alive: () => boolean = () => true): { elements: HTMLElement[]; dispose(): void } {
  const row = (label: string, ...controls: HTMLElement[]) => {
    const r = document.createElement('div');
    r.className = rowClass;
    const l = document.createElement('span');
    l.textContent = label;
    r.append(l, ...controls);
    return r;
  };
  const slider = (aria: string) => {
    const s = document.createElement('input');
    s.type = 'range';
    s.min = '0';
    s.max = '100';
    s.step = '5';
    s.setAttribute('aria-label', aria);
    // Keep keyboard driving keys working after using the slider.
    s.addEventListener('change', () => s.blur());
    return s;
  };
  const toggle = (aria: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'vp-toggle';
    b.setAttribute('aria-label', aria);
    return b;
  };
  const percent = () => document.createElement('small');

  const engine = slider('엔진·효과음 크기');
  const enginePct = percent();
  engine.addEventListener('input', () => setGameVolume(Number(engine.value) / 100));

  const radioOn = toggle('무전 켜기/끄기');
  const radioVol = slider('무전 크기');
  const radioPct = percent();
  const langKo = toggle('무전 음성 한국어');
  langKo.textContent = '한국어';
  const langEn = toggle('무전 음성 영어');
  langEn.textContent = 'English';
  const subs = toggle('자막 켜기/끄기');

  const update = (patch: Partial<RadioSettings>) => saveRadioSettings({ ...readRadioSettings(), ...patch });
  radioOn.addEventListener('click', () => update({ on: !readRadioSettings().on }));
  radioVol.addEventListener('input', () => update({ volume: Number(radioVol.value) / 100 }));
  langKo.addEventListener('click', () => update({ lang: 'ko' }));
  langEn.addEventListener('click', () => update({ lang: 'en' }));
  subs.addEventListener('click', () => update({ subtitles: !readRadioSettings().subtitles }));
  for (const b of [radioOn, langKo, langEn, subs]) b.addEventListener('click', () => b.blur());

  const showEngine = (v: number) => {
    engine.value = String(Math.round(v * 100));
    enginePct.textContent = `${Math.round(v * 100)}%`;
  };
  const showRadio = (s: RadioSettings) => {
    radioOn.textContent = s.on ? '켜짐' : '꺼짐';
    radioOn.classList.toggle('on', s.on);
    radioVol.value = String(Math.round(s.volume * 100));
    radioVol.disabled = !s.on;
    radioPct.textContent = `${Math.round(s.volume * 100)}%`;
    langKo.classList.toggle('on', s.lang === 'ko');
    langEn.classList.toggle('on', s.lang === 'en');
    subs.textContent = s.subtitles ? '켜짐' : '꺼짐';
    subs.classList.toggle('on', s.subtitles);
  };
  showEngine(getGameVolume());
  showRadio(readRadioSettings());
  const dispose = () => {
    offEngine();
    offRadio();
  };
  const offEngine = onGameVolume((v) => (alive() ? showEngine(v) : dispose()));
  const offRadio = onRadioSettings((st) => (alive() ? showRadio(st) : dispose()));
  return {
    elements: [
      row('엔진·효과음', engine, enginePct),
      row('팀 라디오', radioOn, radioVol, radioPct),
      row('무전 음성', langKo, langEn),
      row('무전 자막', subs),
    ],
    dispose,
  };
}
