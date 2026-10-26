import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { initBackdrop, OVER_PLAYER } from '../src/player/backdrop';
import * as ps from '../src/player/playerState';

let stop: () => void;
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div><div id="detail"></div><div id="lsplayer"></div><div id="modal"></div><div id="toast"></div>'
    + '<div class="ss"></div><div class="cvw-root"></div><div class="ctxmenu"></div><div id="x" data-over-player></div><div id="player"></div>';
  stop = initBackdrop();
});
afterEach(() => { stop(); ps.set({ open: false, mini: false }); document.body.innerHTML = ''; });

const inert = (sel: string) => document.querySelector(sel)!.hasAttribute('inert');

describe('fond du lecteur plein écran (LAST-173)', () => {
  it('plein écran : la page est inerte, le lecteur et ses voisins non', () => {
    ps.set({ open: true, mini: false });
    expect(document.body.classList.contains('lp-full')).toBe(true);
    ['#app', '#detail', '#player'].forEach((s) => expect(inert(s)).toBe(true));
    ['#lsplayer', '#modal', '#toast', '.ss', '.cvw-root', '.ctxmenu', '#x'].forEach((s) => expect(inert(s)).toBe(false));
  });

  it('un nœud ajouté après l’ouverture devient inerte, sauf ceux laissés au-dessus', async () => {
    ps.set({ open: true, mini: false });
    const late = document.createElement('div'); late.id = 'late';
    const toast = document.createElement('div'); toast.className = 'toast';
    document.body.append(late, toast);
    await Promise.resolve();
    expect(late.hasAttribute('inert')).toBe(true);
    expect(toast.hasAttribute('inert')).toBe(false);
  });

  it('un inert posé par un tiers est conservé à la fermeture ; les nôtres partent', () => {
    document.getElementById('detail')!.setAttribute('inert', '');
    ps.set({ open: true, mini: false });
    expect(document.getElementById('detail')!.hasAttribute('data-lp-inert')).toBe(false);
    ps.set({ open: false, mini: false });
    expect(document.body.classList.contains('lp-full')).toBe(false);
    expect(inert('#detail')).toBe(true);
    expect(inert('#app')).toBe(false);
    expect(document.querySelector('[data-lp-inert]')).toBeNull();
  });

  it('miniature : tout est relâché (la page reste interactive) ; retour en plein écran : inerte à nouveau', () => {
    ps.set({ open: true, mini: false });
    ps.set({ mini: true });
    expect(document.body.classList.contains('lp-full')).toBe(false);
    expect(document.querySelector('[data-lp-inert]')).toBeNull();
    expect(inert('#app')).toBe(false);
    ps.set({ mini: false });
    expect(inert('#app')).toBe(true);
  });

  it('une fenêtre ouverte depuis le lecteur (Partager) reste interactive', async () => {
    ps.set({ open: true, mini: false });
    const veil = document.createElement('div'); veil.className = 'shd-veil';
    document.body.append(veil);
    await Promise.resolve();
    expect(veil.hasAttribute('inert')).toBe(false);
  });

  it('un nœud verrouillé puis détaché du document est quand même relâché', () => {
    ps.set({ open: true, mini: false });
    const app = document.getElementById('app')!;
    app.remove();
    ps.set({ open: false, mini: false });
    expect(app.hasAttribute('inert')).toBe(false);
    expect(app.hasAttribute('data-lp-inert')).toBe(false);
  });

  it('lecteur ouvert en miniature : rien n’est masqué', () => {
    ps.set({ open: true, mini: true });
    expect(document.body.classList.contains('lp-covered')).toBe(false);
  });
});

describe('CSS et liste OVER_PLAYER alignés', () => {
  it('chaque entrée de OVER_PLAYER figure dans le :not(...) de player.css', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../src/styles/player.css'), 'utf8');
    const m = css.match(/body\.lp-covered > :not\(([^)]*)\)/);
    expect(m).not.toBeNull();
    const inCss = m![1].split(',').map((s) => s.trim()).sort();
    const inTs = OVER_PLAYER.split(',').map((s) => s.trim()).sort();
    expect(inCss).toEqual(inTs);
  });
});
