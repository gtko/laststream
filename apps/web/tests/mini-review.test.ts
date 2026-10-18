// Mini-lecteur : correctifs de relecture (éléments fixes, enfants ajoutés tard, sortie du plein écran de la coque).
import { afterEach, describe, expect, it } from 'vitest';
import { minimizeExits } from '../src/player/mini';
import { PageHole } from '../src/player/minihole.js';

const box = (el: HTMLElement, l: number, t: number, w: number, h: number) => {
  el.getBoundingClientRect = () => ({ left: l, top: t, width: w, height: h, right: l + w, bottom: t + h, x: l, y: t, toJSON() { return {}; } });
};
const hole = { left: 100, top: 100, width: 300, height: 170 };

describe('perçage : relecture', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('un élément position:fixed est découpé mais jamais rendu opaque', () => {
    document.body.innerHTML = '<div id="app"></div><div id="bar" style="position:fixed"></div>';
    const app = document.getElementById('app')!;
    const bar = document.getElementById('bar')!;
    box(app, 0, 0, 800, 600);
    box(bar, 0, 0, 800, 60);
    const h = new PageHole();
    h.apply(hole);
    expect(app.style.background).toBe('var(--bg)');
    expect(app.style.minHeight).toBe('100vh');
    expect(bar.style.background).toBe('');
    expect(bar.style.minHeight).toBe('');
    expect(bar.style.clipPath).toBe(''); // le trou ne touche pas la barre
    box(bar, 0, 90, 800, 60);
    h.paint();
    expect(bar.style.clipPath).toContain('evenodd');
    expect(bar.style.background).toBe('');
    h.apply(null);
  });

  it('un conteneur ajouté après watch() puis affiché est percé', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    box(document.getElementById('app')!, 0, 0, 800, 600);
    const h = new PageHole();
    h.apply(hole);
    const late = document.createElement('div');
    late.hidden = true;
    document.body.appendChild(late);
    box(late, 0, 0, 800, 600);
    await new Promise((r) => setTimeout(r, 50)); // childList : repeint, le nouveau nœud est désormais observé
    expect(late.style.clipPath).toBe('');
    late.hidden = false;
    await new Promise((r) => setTimeout(r, 50));
    expect(late.style.clipPath).toContain('evenodd');
    h.apply(null);
    expect(late.style.clipPath).toBe('');
  });
});

describe('réduire et plein écran', () => {
  it('quitte aussi le plein écran de la coque', () => {
    expect(minimizeExits({ docFullscreen: false, shell: true, shellFullscreen: true })).toEqual({ exitDoc: false, exitShell: true });
    expect(minimizeExits({ docFullscreen: true, shell: false, shellFullscreen: true })).toEqual({ exitDoc: true, exitShell: false });
    expect(minimizeExits({ docFullscreen: false, shell: true, shellFullscreen: false })).toEqual({ exitDoc: false, exitShell: false });
  });
});
