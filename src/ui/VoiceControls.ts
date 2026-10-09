import type { Room } from '../net/Room';
import type { Voice } from '../net/Voice';

/**
 * Voice chat UI: a section in the lobby (turn the mic on, push-to-talk or
 * open mic, mute, per-player mute and volume) and a small overlay during the
 * race (who is talking, PTT hint, the same controls in a pop-up; a big mic
 * button on touch screens). Talking players get 🎙️ next to their name.
 */

const STYLE = `
.voice-box { display: grid; gap: 8px; }
.voice-box .voice-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.voice-btn { padding: 9px 13px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.08); color: #fff; font: 600 14px system-ui, sans-serif; cursor: pointer; }
.voice-btn:hover { background: rgba(255,255,255,0.16); }
.voice-btn.on { background: rgba(255,210,63,0.22); border-color: #ffd23f; color: #ffd23f; }
.voice-btn.primary { background: #1f8f4e; border-color: #2fbf6c; }
.voice-hint { color: #8b97a5; font-size: 13px; }
.voice-peer { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.voice-peer input[type=range] { width: 70px; accent-color: #ffd23f; }
.voice-peer button { background: none; border: 0; color: #fff; font-size: 15px; cursor: pointer; padding: 2px 4px; }
.voice-mic { font-size: 14px; opacity: 0; transition: opacity 0.1s; }
.voice-mic.on { opacity: 1; }
.voice-hud { position: fixed; left: 12px; bottom: 230px; z-index: 31; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; font: 600 13px system-ui, sans-serif; color: #fff; pointer-events: none; }
.voice-hud .voice-chip { pointer-events: auto; display: flex; gap: 8px; align-items: center; padding: 6px 10px; border-radius: 10px; background: rgba(10,14,22,0.72); border: 1px solid rgba(255,255,255,0.14); cursor: pointer; }
.voice-hud .voice-chip.tx { border-color: #2fbf6c; background: rgba(31,143,78,0.55); }
.voice-hud .voice-talker { padding: 4px 10px; border-radius: 8px; background: rgba(10,14,22,0.72); border-left: 3px solid #ffd23f; }
.voice-pop { position: fixed; left: 12px; bottom: 270px; z-index: 32; width: min(340px, calc(100vw - 24px)); max-height: 60vh; overflow: auto; padding: 12px; border-radius: 12px; background: rgba(10,14,22,0.92); border: 1px solid rgba(255,255,255,0.14); color: #fff; font: 14px system-ui, sans-serif; display: none; }
.voice-pop.show { display: block; }
.voice-pop ul { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 6px; }
.voice-pop li { display: flex; align-items: center; gap: 6px; }
.voice-ptt { position: fixed; right: calc(140px + env(safe-area-inset-right)); bottom: calc(134px + env(safe-area-inset-bottom)); width: 62px; height: 62px; border-radius: 50%; z-index: 31; font-size: 26px; display: none; place-items: center; touch-action: none; user-select: none; -webkit-user-select: none; color: #fff; border: 2px solid rgba(255,255,255,0.35); background: rgba(10,14,20,0.38); }
body.touch .voice-ptt.ready { display: grid; }
.voice-ptt.down { background: rgba(47,191,108,0.7); border-color: #fff; }
body.touch .voice-hud { bottom: auto; top: calc(56px + env(safe-area-inset-top)); left: calc(8px + env(safe-area-inset-left)); }
body.touch .voice-pop { bottom: auto; top: calc(92px + env(safe-area-inset-top)); }
`;

let styled = false;
function ensureStyle(): void {
  if (styled) return;
  styled = true;
  const s = document.createElement('style');
  s.textContent = STYLE;
  document.head.append(s);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

function btn(text: string, onClick: () => void, className = 'voice-btn'): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  b.addEventListener('click', (e) => {
    e.preventDefault();
    onClick();
  });
  return b;
}

/** Mic on / mode / mute controls (shared by the lobby and the race pop-up). */
function controls(voice: Voice, status: (t: string, error?: boolean) => void, rerender: () => void): HTMLElement {
  const box = el('div', 'voice-box');
  const row = el('div', 'voice-row');
  if (!voice.micOn) {
    row.append(
      btn(
        '🎙️ 음성 채팅 켜기',
        () => {
          status('마이크 권한을 요청하는 중…');
          voice.enableMic().then(
            () => {
              status('음성 채팅이 켜졌습니다');
              rerender();
            },
            (e: unknown) => status(`마이크를 쓸 수 없어요: ${e instanceof Error ? e.message : String(e)}`, true),
          );
        },
        'voice-btn primary',
      ),
    );
  } else {
    const mode = (m: 'ptt' | 'open', label: string) =>
      btn(label, () => {
        voice.setMode(m);
        rerender();
      }, `voice-btn${voice.mode === m ? ' on' : ''}`);
    row.append(mode('ptt', '누르고 말하기'), mode('open', '항상 켜기'));
    row.append(
      btn(voice.selfMuted ? '🔇 내 마이크 꺼짐' : '🎙️ 내 마이크', () => {
        voice.setSelfMuted(!voice.selfMuted);
        rerender();
      }, `voice-btn${voice.selfMuted ? ' on' : ''}`),
    );
  }
  row.append(
    btn(voice.deafened ? '🔈 소리 꺼짐' : '🔊 듣기', () => {
      voice.setDeafened(!voice.deafened);
      rerender();
    }, `voice-btn${voice.deafened ? ' on' : ''}`),
  );
  box.append(row);
  const hint = el('div', 'voice-hint');
  hint.textContent = !voice.micOn
    ? '켜지 않아도 친구 목소리는 들려요. 마이크는 켤 때 한 번 권한을 물어봅니다.'
    : voice.mode === 'ptt'
      ? 'V 키(모바일: 🎙️ 버튼)를 누르고 있는 동안만 전송됩니다.'
      : '말할 때 자동으로 전송됩니다.';
  box.append(hint);
  return box;
}

/** Per-player mute + volume + talking indicator (not for yourself). */
function peerControls(voice: Voice, id: string, me: boolean): HTMLElement {
  const wrap = el('span', 'voice-peer');
  const mic = el('span', 'voice-mic', '🎙️');
  mic.dataset.voiceId = id;
  wrap.append(mic);
  if (me) return wrap;
  const prefs = voice.peerPrefs(id);
  const mute = btn(prefs.muted ? '🔇' : '🔊', () => {
    voice.setPeerMuted(id, !voice.peerPrefs(id).muted);
    mute.textContent = voice.peerPrefs(id).muted ? '🔇' : '🔊';
  }, '');
  mute.title = '이 사람 음소거';
  const vol = el('input');
  vol.type = 'range';
  vol.min = '0';
  vol.max = '2';
  vol.step = '0.05';
  vol.value = String(prefs.volume);
  vol.title = '볼륨';
  vol.addEventListener('input', () => voice.setPeerVolume(id, Number(vol.value)));
  wrap.append(mute, vol);
  return wrap;
}

/** Lights up 🎙️ markers in place (no re-render, so sliders keep working). */
function refreshMarkers(voice: Voice, root: ParentNode): void {
  for (const m of root.querySelectorAll<HTMLElement>('.voice-mic[data-voice-id]')) m.classList.toggle('on', voice.isSpeaking(m.dataset.voiceId!));
}

/** Lobby: the voice section and decorations for the player list. */
export function lobbyVoice(room: Room, status: (t: string, error?: boolean) => void, rerender: () => void): {
  section: HTMLElement;
  decorate(li: HTMLElement, id: string): void;
  refresh(root: ParentNode): void;
} {
  ensureStyle();
  const voice = room.voice;
  const section = el('div');
  section.append(el('h2', '', '음성 채팅'), controls(voice, status, rerender));
  return {
    section,
    decorate: (li, id) => li.append(peerControls(voice, id, id === room.myId)),
    refresh: (root) => refreshMarkers(voice, root),
  };
}

/** During the race: talking list, PTT chip / button, settings pop-up. */
export class VoiceOverlay {
  private readonly hud = el('div', 'voice-hud');
  private readonly chip = el('div', 'voice-chip');
  private readonly talkers = el('div');
  private readonly pop = el('div', 'voice-pop');
  private readonly ptt = el('button', 'voice-ptt', '🎙️');
  private readonly status = el('div', 'voice-hint');

  constructor(
    private readonly room: Room,
    private readonly names: () => Map<string, string>,
  ) {
    ensureStyle();
    const voice = room.voice;
    this.chip.addEventListener('click', () => {
      this.pop.classList.toggle('show');
      this.renderPop();
    });
    this.hud.append(this.chip, this.talkers);
    this.ptt.type = 'button';
    this.ptt.setAttribute('aria-label', '누르고 말하기');
    const down = (e: PointerEvent) => {
      e.preventDefault();
      this.ptt.setPointerCapture(e.pointerId);
      voice.setTalking(true);
      this.ptt.classList.add('down');
    };
    const up = () => {
      voice.setTalking(false);
      this.ptt.classList.remove('down');
    };
    this.ptt.addEventListener('pointerdown', down);
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) this.ptt.addEventListener(t, up);
    this.ptt.addEventListener('contextmenu', (e) => e.preventDefault());
    document.body.append(this.hud, this.pop, this.ptt);
    voice.onChange = () => this.update();
    this.update();
  }

  dispose(): void {
    if (this.room.voice.onChange) this.room.voice.onChange = undefined;
    this.hud.remove();
    this.pop.remove();
    this.ptt.remove();
  }

  private update(): void {
    const voice = this.room.voice;
    const tx = voice.transmittingNow;
    this.chip.className = `voice-chip${tx ? ' tx' : ''}`;
    this.chip.textContent = !voice.micOn
      ? '🎧 음성 채팅'
      : voice.selfMuted
        ? '🔇 마이크 꺼짐'
        : tx
          ? '🎙️ 전송 중…'
          : voice.mode === 'ptt'
            ? '🎙️ V: 무전'
            : '🎙️ 항상 켜짐';
    this.ptt.classList.toggle('ready', voice.micOn && voice.mode === 'ptt' && !voice.selfMuted);
    const names = this.names();
    const talking = [...names.entries()].filter(([id]) => id !== this.room.myId && voice.isSpeaking(id));
    this.talkers.replaceChildren(...talking.map(([, n]) => el('div', 'voice-talker', `🎙️ ${n}`)));
    if (this.pop.classList.contains('show')) refreshMarkers(voice, this.pop);
  }

  private renderPop(): void {
    const voice = this.room.voice;
    const say = (t: string, error = false) => {
      this.status.textContent = t;
      this.status.style.color = error ? '#ff6b6b' : '';
    };
    const list = el('ul');
    for (const [id, name] of this.names()) {
      const li = el('li');
      li.append(el('span', '', id === this.room.myId ? `${name} (나)` : name), peerControls(voice, id, id === this.room.myId));
      list.append(li);
    }
    const close = btn('닫기', () => this.pop.classList.remove('show'));
    this.pop.replaceChildren(el('strong', '', '음성 채팅'), controls(voice, say, () => this.renderPop()), this.status, list, close);
    refreshMarkers(voice, this.pop);
    this.update();
  }
}
