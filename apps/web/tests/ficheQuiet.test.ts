import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUIET_GAP_PX, ficheQuietSetup, ficheQuietStop } from '../src/ui/ficheQuiet.js';

// jsdom n'a pas de mise en page : offsetLeft/offsetTop/offsetHeight sont simulés (les rects, eux, ne servent plus).
const offs = (el: HTMLElement, o: { left: number; top: number; height: number }) => {
  Object.defineProperty(el, 'offsetLeft', { configurable: true, get: () => o.left });
  Object.defineProperty(el, 'offsetTop', { configurable: true, get: () => o.top });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => o.height });
};

function build(withLogo: boolean) {
  const zone = document.createElement('div');
  zone.innerHTML = '<div class="f-info"><h1 class="f-title">' +
    (withLogo ? '<img class="logo-img f-logo" alt="T">' : '<span class="title-text">Titre</span>') +
    '</h1><p class="f-ov">Synopsis</p><div class="f-actions"><button class="btn btn-primary" data-play>Lecture</button></div></div>';
  document.body.appendChild(zone);
  const title = zone.querySelector('.f-title') as HTMLElement;
  const play = zone.querySelector('[data-play]') as HTMLElement;
  offs(title, { left: 40, top: 100, height: 100 });
  offs(play, { left: 40, top: 500, height: 48 });
  return { zone, title, play };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const mm = (reduce: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduce && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }));

describe('fiche : logo vers le bouton Lecture (bande-annonce en grand)', () => {
  beforeEach(() => mm(false));
  afterEach(() => { ficheQuietStop(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

  for (const withLogo of [true, false]) {
    it(`calcule le décalage FLIP (${withLogo ? 'logo' : 'titre texte'}) : bas du titre à ${QUIET_GAP_PX} px au-dessus de Lecture`, () => {
      const { zone, title } = build(withLogo);
      ficheQuietSetup(zone);
      expect(title.style.getPropertyValue('--f-qx')).toBe('0px');
      expect(title.style.getPropertyValue('--f-qy')).toBe(500 - QUIET_GAP_PX - 200 + 'px');
    });
  }

  it('l’état grand arme will-change le temps de la transition, le retour le retire', async () => {
    vi.useFakeTimers();
    const { zone, title } = build(true);
    ficheQuietSetup(zone);
    expect(title.style.willChange).toBe('');
    zone.classList.add('is-quiet');
    await vi.advanceTimersByTimeAsync(0);
    expect(title.style.willChange).toBe('transform');
    expect(title.style.transition).toBe('');
    await vi.advanceTimersByTimeAsync(700);
    expect(title.style.willChange).toBe('');
    zone.classList.remove('is-quiet');
    await vi.advanceTimersByTimeAsync(0);
    expect(title.style.willChange).toBe('transform');
    await vi.advanceTimersByTimeAsync(700);
    expect(title.style.willChange).toBe('');
    vi.useRealTimers();
  });

  it('redimensionnement : le décalage est recalculé', () => {
    const { zone, title, play } = build(true);
    ficheQuietSetup(zone);
    offs(play, { left: 60, top: 400, height: 48 });
    window.dispatchEvent(new Event('resize'));
    expect(title.style.getPropertyValue('--f-qx')).toBe('20px');
    expect(title.style.getPropertyValue('--f-qy')).toBe(400 - QUIET_GAP_PX - 200 + 'px');
  });

  it('redimensionnement pendant l’état grand : mesure par offset, sans toucher à la transformation ni à la transition', async () => {
    const { zone, title, play } = build(true);
    ficheQuietSetup(zone);
    zone.classList.add('is-quiet');
    await flush();
    const gbcr = vi.spyOn(title, 'getBoundingClientRect');
    offs(play, { left: 40, top: 300, height: 48 });
    window.dispatchEvent(new Event('resize'));
    expect(title.style.transform).toBe('');
    expect(title.style.transition).toBe('');
    expect(gbcr).not.toHaveBeenCalled();
    expect(title.style.getPropertyValue('--f-qy')).toBe(300 - QUIET_GAP_PX - 200 + 'px');
  });

  it('ResizeObserver : observe le titre et .f-info, jamais la zone (#detail)', () => {
    const seen: Element[] = [];
    vi.stubGlobal('ResizeObserver', class { constructor(public cb: () => void) {} observe(e: Element) { seen.push(e); } disconnect() {} });
    const { zone, title } = build(true);
    ficheQuietSetup(zone);
    expect(seen).toEqual([title, zone.querySelector('.f-info')]);
  });

  it('mouvement réduit : aucune transition, pas de will-change', async () => {
    mm(true);
    const { zone, title } = build(true);
    ficheQuietSetup(zone);
    zone.classList.add('is-quiet');
    await flush();
    expect(title.style.transition).toBe('none');
    expect(title.style.willChange).toBe('');
  });

  it('démontage : variables, écouteurs et observateur retirés', async () => {
    const { zone, title, play } = build(true);
    ficheQuietSetup(zone);
    ficheQuietStop();
    expect(title.style.getPropertyValue('--f-qy')).toBe('');
    offs(play, { left: 60, top: 400, height: 48 });
    window.dispatchEvent(new Event('resize'));
    zone.classList.add('is-quiet');
    await flush();
    expect(title.style.getPropertyValue('--f-qy')).toBe('');
    expect(title.style.willChange).toBe('');
  });

  it('sans bouton principal : ne fait rien', () => {
    const zone = document.createElement('div');
    zone.innerHTML = '<div class="f-info"><h1 class="f-title">T</h1></div>';
    expect(() => ficheQuietSetup(zone)).not.toThrow();
  });
});
