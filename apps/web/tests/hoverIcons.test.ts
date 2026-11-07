// ODY-177 : survoler ✕ (retirer) ou ••• (menu) d'une carte « Reprendre la lecture » ne déclenche pas le survol de la carte.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let hoverTileOf: typeof import('../src/ui/hover.js').hoverTileOf;
let scheduleHover: typeof import('../src/ui/hover.js').scheduleHover;
let hv: typeof import('../src/ui/hover.js').hv;
let trackIconHover: typeof import('../src/ui/hover.js').trackIconHover;

beforeAll(async () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  ({ hoverTileOf, trackIconHover, scheduleHover, hv } = await import('../src/ui/hover.js'));
});

function card(): HTMLElement {
  document.body.innerHTML = '<button class="card tile tile-land cont-card" data-tile="tt1"><span class="card-media">'
    + '<span class="t-more">•••</span><span class="t-remove" data-continue-remove="tt1"><svg></svg></span></span></button>';
  return document.querySelector('.cont-card') as HTMLElement;
}

describe('aperçu de la carte (hoverTileOf)', () => {
  it('ouvre l\'aperçu sur le reste de la carte', () => {
    const c = card();
    expect(hoverTileOf(c.querySelector('.card-media'))).toBe(c);
  });
  it('ne l\'ouvre pas sur ••• ni sur ✕ (ni leurs enfants)', () => {
    const c = card();
    expect(hoverTileOf(c.querySelector('.t-more'))).toBeNull();
    expect(hoverTileOf(c.querySelector('.t-remove'))).toBeNull();
    expect(hoverTileOf(c.querySelector('.t-remove svg'))).toBeNull();
  });
});

describe('survol de ✕ / ••• (trackIconHover)', () => {
  const rect = (l: number, t: number, w: number, h: number) => ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h }) as DOMRect;
  it('retire le survol de la carte sur l’icône, le garde sur la zone zoomée, le rend en la quittant', () => {
    const c = card();
    const rm = c.querySelector('.t-remove') as HTMLElement;
    rm.getBoundingClientRect = () => rect(100, 100, 28, 28);
    trackIconHover(110, 110, rm);
    expect(c.classList.contains('is-icon-hover')).toBe(true);
    // Sans zoom l'icône s'est décalée : la souris est sur la carte mais encore dans l'ancienne zone de l'icône.
    trackIconHover(105, 105, c.querySelector('.card-media'));
    expect(c.classList.contains('is-icon-hover')).toBe(true);
    trackIconHover(200, 200, c.querySelector('.card-media'));
    expect(c.classList.contains('is-icon-hover')).toBe(false);
  });
});

describe('aperçu dans la zone gardée', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('ne s’ouvre pas tant que la carte porte is-icon-hover, puis redevient possible', () => {
    vi.useFakeTimers();
    const c = card();
    c.classList.add('is-icon-hover');
    scheduleHover(c, 900);
    vi.advanceTimersByTime(900);
    expect(hv.openTimer).not.toBeNull(); // délai réarmé, rien d’ouvert
    c.classList.remove('is-icon-hover');
    vi.advanceTimersByTime(900);
    expect(hv.openTimer).toBeNull(); // l’ouverture a été tentée
  });
});

describe('survol CSS de la carte', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../src/styles/app.css'), 'utf8');
  it('annule zoom, liseré et ▶ quand la carte porte is-icon-hover', () => {
    const sel = '.card.is-icon-hover:not(:focus-visible)';
    expect(css).toContain(sel + ' { transform: none; }');
    expect(css).toContain(sel + ' .card-media { outline: none; }');
    expect(css).toContain(sel.replace('.card', '.cont-card') + ' .cont-play { opacity: 0; }');
  });
});
