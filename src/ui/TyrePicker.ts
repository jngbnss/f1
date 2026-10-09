import { urlWith } from '../config';
import { COMPOUND_COLORS } from '../vehicle/cars/GltfF1Visual';
import { COMPOUND_HINTS, COMPOUND_LIST, COMPOUND_NAMES, type Compound } from '../vehicle/Tyres';

/**
 * Starting tyre for the player, picked in the menu (5 compounds, softest to
 * wet). Remembered in the browser; `?tyre=soft` in the URL wins.
 */
export function readStartTyre(): Compound {
  const fromUrl = new URLSearchParams(window.location.search).get('tyre');
  let stored: string | null = null;
  try {
    stored = localStorage.getItem('tyre');
  } catch {
    /* storage blocked */
  }
  const pick = (fromUrl ?? stored ?? 'medium') as Compound;
  return COMPOUND_LIST.includes(pick) ? pick : 'medium';
}

export function mountTyrePicker(el: HTMLElement): void {
  let current = readStartTyre();
  const title = document.createElement('h2');
  title.textContent = '출발 타이어';
  const grid = document.createElement('div');
  grid.className = 'menu-grid';
  const render = () =>
    grid.replaceChildren(
      ...COMPOUND_LIST.map((c) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'menu-card' + (c === current ? ' selected' : '');
        const strong = document.createElement('strong');
        const dot = document.createElement('span');
        dot.style.cssText = `display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:6px;vertical-align:-1px;border:3px solid #${COMPOUND_COLORS[c].toString(16).padStart(6, '0')}`;
        strong.append(dot, COMPOUND_NAMES[c]);
        const span = document.createElement('span');
        span.textContent = COMPOUND_HINTS[c];
        b.append(strong, span);
        b.addEventListener('click', () => {
          current = c;
          try {
            localStorage.setItem('tyre', c);
          } catch {
            /* the URL still carries it */
          }
          history.replaceState(null, '', urlWith({ tyre: c }));
          render();
        });
        return b;
      }),
    );
  render();
  el.replaceChildren(title, grid);
}
