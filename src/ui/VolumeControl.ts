import { getGameVolume, onGameVolume, setGameVolume } from '../audio/AudioSystem';
import { music, onMusicSettings, readMusicSettings, saveMusicSettings, type MusicSettings, type MusicTrack } from '../audio/Music';
import { onRadioSettings, readRadioSettings, saveRadioSettings, type RadioSettings } from '../audio/TeamRadio';

/**
 * Sound settings: a small 🔊 button (bottom centre on desktop) that opens a
 * panel with the engine / effects volume, the background music (only when
 * public/audio/bgm has tracks) and the team radio (on/off, its own
 * volume, subtitles; the engineer speaks English). Touch screens get the same rows inside
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

/** Engine / effects volume + music + team radio settings, kept in sync with changes made elsewhere. */
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
  const subs = toggle('자막 켜기/끄기');

  const musicOn = toggle('배경음악 켜기/끄기');
  const musicVol = slider('배경음악 크기');
  const musicPct = percent();
  const skip = toggle('다음 곡');
  skip.textContent = '⏭';
  const musicRow = row('배경음악', musicOn, musicVol, musicPct, skip);
  musicRow.hidden = !music.available;
  const saveMusic = (patch: Partial<MusicSettings>) => saveMusicSettings({ ...readMusicSettings(), ...patch });
  musicOn.addEventListener('click', () => saveMusic({ on: !readMusicSettings().on }));
  musicVol.addEventListener('input', () => saveMusic({ volume: Number(musicVol.value) / 100 }));
  skip.addEventListener('click', () => music.next());
  for (const b of [musicOn, skip]) b.addEventListener('click', () => b.blur());

  const update = (patch: Partial<RadioSettings>) => saveRadioSettings({ ...readRadioSettings(), ...patch });
  radioOn.addEventListener('click', () => update({ on: !readRadioSettings().on }));
  radioVol.addEventListener('input', () => update({ volume: Number(radioVol.value) / 100 }));
  subs.addEventListener('click', () => update({ subtitles: !readRadioSettings().subtitles }));
  for (const b of [radioOn, subs]) b.addEventListener('click', () => b.blur());

  const showMusic = (s: MusicSettings) => {
    musicOn.textContent = s.on ? '켜짐' : '꺼짐';
    musicOn.classList.toggle('on', s.on);
    musicVol.value = String(Math.round(s.volume * 100));
    musicVol.disabled = !s.on;
    musicPct.textContent = `${Math.round(s.volume * 100)}%`;
    skip.disabled = !s.on;
  };
  // A track appears once the playlist has loaded: show the row and name the song.
  const showTrack = (t: MusicTrack | null) => {
    musicRow.hidden = !t;
    musicRow.title = t ? `♪ ${t.title ?? t.src}` : '';
  };

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
    subs.textContent = s.subtitles ? '켜짐' : '꺼짐';
    subs.classList.toggle('on', s.subtitles);
  };
  showEngine(getGameVolume());
  showRadio(readRadioSettings());
  showMusic(readMusicSettings());
  const dispose = () => {
    offEngine();
    offRadio();
    offMusic();
    offTrack();
  };
  const offEngine = onGameVolume((v) => (alive() ? showEngine(v) : dispose()));
  const offRadio = onRadioSettings((st) => (alive() ? showRadio(st) : dispose()));
  const offMusic = onMusicSettings((st) => (alive() ? showMusic(st) : dispose()));
  const offTrack = music.onTrack((t) => (alive() ? showTrack(t) : dispose()));
  return {
    elements: [
      row('엔진·효과음', engine, enginePct),
      musicRow,
      row('팀 라디오', radioOn, radioVol, radioPct),
      row('무전 자막', subs),
    ],
    dispose,
  };
}
