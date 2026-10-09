import type { RacePlan, LobbyState } from '../net/protocol';
import type { Room } from '../net/Room';
import { CAR_LIST } from '../vehicle/catalog';
import { lobbyVoice } from './VoiceControls';

/**
 * Multiplayer lobby: pick a name and a team, create a room (or join one
 * from a ?room=CODE link), share the code, wait for friends; the host sets
 * laps / AI fill and starts the race. Resolves when the race starts.
 */

const TEAMS = CAR_LIST.filter((c) => c.cls === 'formula');
const LAPS = [1, 3, 5];

const css = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

function stored(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: not remembered */
  }
}

const STYLE = `
.lobby .lobby-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.lobby input.lobby-name { flex: 1 1 200px; min-width: 0; padding: 12px 14px; font-size: 16px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.06); color: #fff; }
.lobby .lobby-code { font: 800 34px/1 ui-monospace, monospace; letter-spacing: 6px; color: #ffd23f; }
.lobby .lobby-btn { padding: 10px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.08); color: #fff; font-size: 14px; cursor: pointer; }
.lobby .lobby-btn:hover { background: rgba(255,255,255,0.16); }
.lobby .lobby-players { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.lobby .lobby-players li { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; background: rgba(255,255,255,0.06); font-size: 14px; }
.lobby .lobby-players li i { width: 6px; align-self: stretch; border-radius: 3px; }
.lobby .lobby-players li.me { outline: 1px solid #ffd23f; }
.lobby .lobby-players li small { color: #8b97a5; }
.lobby .menu-card.full { opacity: 0.4; pointer-events: none; }
.lobby .menu-card .swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.lobby .lobby-status { color: #8b97a5; font-size: 14px; min-height: 1.4em; }
.lobby .lobby-status.error { color: #ff6b6b; }
.lobby .menu-start[disabled] { opacity: 0.5; cursor: default; }
`;

export interface LobbyResult {
  room: Room;
  plan: RacePlan;
}

export function runLobby(code: string | null): Promise<LobbyResult> {
  return new Promise((resolve) => {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.append(style);

    let name = stored('mp-name', '');
    let team = stored('mp-team', TEAMS[0].id);
    if (!TEAMS.some((t) => t.id === team)) team = TEAMS[0].id;
    let room: Room | null = null;
    let busy = false;

    const root = document.createElement('div');
    root.className = 'menu lobby';
    root.innerHTML = `
      <div class="menu-panel">
        <h1>web-sim-lab <span>멀티플레이</span></h1>
        <div data-part="room"></div>
        <h2>내 이름</h2>
        <div class="lobby-row"><input class="lobby-name" maxlength="12" placeholder="이름 (최대 12자)" /></div>
        <h2>팀 <small>팀당 2명까지</small></h2>
        <div class="menu-grid" data-part="teams"></div>
        <div data-part="players"></div>
        <div data-part="voice"></div>
        <div data-part="settings"></div>
        <p class="lobby-status" data-part="status"></p>
        <div class="lobby-row">
          <button class="menu-start" type="button" data-part="main"></button>
          <button class="lobby-btn" type="button" data-part="back">← 메뉴로</button>
        </div>
        <p class="menu-note">서버 없이 브라우저끼리 직접 연결합니다(WebRTC · PeerJS). 방을 만든 사람이 방장이고, 방장이 나가면 레이스가 끝납니다. 서킷: 몬자.</p>
      </div>`;
    const part = (p: string) => root.querySelector<HTMLElement>(`[data-part="${p}"]`)!;
    const nameInput = root.querySelector<HTMLInputElement>('.lobby-name')!;
    nameInput.value = name;
    const status = (text: string, error = false) => {
      part('status').textContent = text;
      part('status').className = `lobby-status${error ? ' error' : ''}`;
    };

    const lobby = (): LobbyState | null => room?.lobby ?? null;

    const render = () => {
      const state = lobby();
      const taken = (id: string) => state?.players.filter((p) => p.team === id && p.id !== room?.myId).length ?? 0;
      part('teams').replaceChildren(
        ...TEAMS.map((t) => {
          const el = document.createElement('button');
          el.type = 'button';
          const n = taken(t.id);
          el.className = `menu-card${t.id === team ? ' selected' : ''}${n >= 2 ? ' full' : ''}`;
          el.innerHTML = `<strong><span class="swatch"></span></strong><span></span>`;
          (el.querySelector('.swatch') as HTMLElement).style.background = css(t.spec.color);
          el.querySelector('strong')!.append(t.spec.brand);
          el.querySelector('span:not(.swatch)')!.textContent = n ? `${n}/2 선택됨` : '비어 있음';
          el.addEventListener('click', () => {
            team = t.id;
            store('mp-team', team);
            room?.setProfile(currentName(), team);
            render();
          });
          return el;
        }),
      );

      if (room && state) {
        const link = `${location.origin}${location.pathname}?room=${room.code}`;
        part('room').innerHTML = `
          <h2>방 코드 <small>친구에게 코드나 링크를 보내세요 · 최대 20명</small></h2>
          <div class="lobby-row"><span class="lobby-code"></span>
            <button class="lobby-btn" type="button" data-act="copy">🔗 링크 복사</button>
            ${'share' in navigator ? '<button class="lobby-btn" type="button" data-act="share">공유…</button>' : ''}
          </div>`;
        part('room').querySelector('.lobby-code')!.textContent = room.code;
        part('room').querySelector('[data-act="copy"]')!.addEventListener('click', () => {
          navigator.clipboard?.writeText(link).then(
            () => status('링크를 복사했습니다'),
            () => status(link),
          );
        });
        part('room')
          .querySelector('[data-act="share"]')
          ?.addEventListener('click', () => navigator.share({ title: 'web-sim-lab 레이스', text: `방 코드 ${room!.code}`, url: link }).catch(() => {}));

        const voice = lobbyVoice(room, status, render);
        part('voice').replaceChildren(voice.section);
        const list = document.createElement('ul');
        list.className = 'lobby-players';
        for (const p of state.players) {
          const li = document.createElement('li');
          if (p.id === room.myId) li.className = 'me';
          const bar = document.createElement('i');
          const def = TEAMS.find((t) => t.id === p.team);
          bar.style.background = css(def?.spec.color ?? 0x888888);
          const label = document.createElement('span');
          label.textContent = `${p.host ? '👑 ' : ''}${p.name}`;
          const small = document.createElement('small');
          small.textContent = def?.spec.brand ?? '';
          li.append(bar, label, small);
          voice.decorate(li, p.id);
          list.append(li);
        }
        part('players').replaceChildren(Object.assign(document.createElement('h2'), { textContent: `참가자 ${state.players.length}/20` }), list);

        if (room.isHost) {
          const box = document.createElement('div');
          box.innerHTML = '<h2>레이스 설정</h2><div class="menu-grid menu-laps" data-s="laps"></div><div class="menu-grid" data-s="ai" style="margin-top:10px"></div>';
          const card = (title: string, sub: string, selected: boolean, onPick: () => void) => {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = `menu-card${selected ? ' selected' : ''}`;
            el.innerHTML = '<strong></strong><span></span>';
            el.querySelector('strong')!.textContent = title;
            el.querySelector('span')!.textContent = sub;
            el.addEventListener('click', onPick);
            return el;
          };
          box.querySelector('[data-s="laps"]')!.append(
            ...LAPS.map((n) => card(`${n} 랩`, n === 1 ? '스프린트' : n === 3 ? '기본' : '내구', n === state.laps, () => room!.setSettings(n, state.aiFill))),
          );
          box.querySelector('[data-s="ai"]')!.append(
            card('AI로 채우기', `빈 자리 ${Math.max(0, 20 - state.players.length)}대를 AI가 달림`, state.aiFill, () => room!.setSettings(state.laps, true)),
            card('사람끼리만', `${state.players.length}대만 출발`, !state.aiFill, () => room!.setSettings(state.laps, false)),
          );
          part('settings').replaceChildren(box);
        } else {
          part('settings').innerHTML = `<h2>레이스</h2><p class="lobby-status">${state.laps}랩 · ${state.aiFill ? 'AI로 빈자리 채움' : '사람끼리만'} · 방장이 출발을 누르면 시작합니다</p>`;
        }
      }

      const main = part('main') as HTMLButtonElement;
      if (!room) {
        main.textContent = code ? `방 ${code} 참가 ▶` : '방 만들기 ▶';
        main.disabled = busy;
      } else if (room.isHost) {
        main.textContent = '레이스 출발 ▶';
        main.disabled = busy;
      } else {
        main.textContent = '방장을 기다리는 중…';
        main.disabled = true;
      }
    };

    const currentName = () => {
      const n = nameInput.value.trim() || `Driver${Math.floor(Math.random() * 90 + 10)}`;
      store('mp-name', n);
      return n;
    };
    let nameTimer = 0;
    nameInput.addEventListener('input', () => {
      clearTimeout(nameTimer);
      nameTimer = window.setTimeout(() => room?.setProfile(currentName(), team), 400);
    });

    const wire = (r: Room) => {
      room = r;
      // Test/debug handle (like window.sim for the race).
      (window as unknown as { netRoom?: Room }).netRoom = r;
      r.voice.onChange = () => {
        for (const m of root.querySelectorAll<HTMLElement>('.voice-mic[data-voice-id]')) m.classList.toggle('on', r.voice.isSpeaking(m.dataset.voiceId!));
      };
      r.onLobby = (s) => {
        const me = s.players.find((p) => p.id === r.myId);
        if (me) team = me.team;
        render();
      };
      r.onStart = (plan) => {
        root.remove();
        style.remove();
        resolve({ room: r, plan });
      };
      r.onEnd = (reason) => {
        room = null;
        status(reason, true);
        render();
      };
    };

    part('main').addEventListener('click', async () => {
      if (busy) return;
      if (room) {
        if (room.isHost) {
          busy = true;
          render();
          room.startRace();
        }
        return;
      }
      busy = true;
      status(code ? '방에 연결하는 중…' : '방을 만드는 중…');
      render();
      try {
        const { Room } = await import('../net/Room');
        const r = code ? await Room.join(code, currentName(), team) : await Room.create(currentName(), team);
        wire(r);
        status(r.isHost ? '방이 열렸습니다. 친구에게 코드를 보내세요.' : '참가했습니다!');
      } catch (e) {
        status(e instanceof Error ? e.message : `연결 실패: ${String((e as { type?: string }).type ?? e)}`, true);
      }
      busy = false;
      render();
    });
    part('back').addEventListener('click', () => {
      room?.leave();
      const p = new URLSearchParams(location.search);
      p.delete('room');
      p.set('menu', '');
      location.href = `${location.pathname}?${p.toString().replace(/=(&|$)/g, '$1')}`;
    });

    render();
    document.body.append(root);
    // Opened from a ?room= link with a remembered name: join right away.
    if (code && name) part('main').click();
  });
}
