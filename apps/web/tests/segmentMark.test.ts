import { afterEach, describe, expect, it, vi } from 'vitest';
import { guessKind, initialRange, MARK_MIN, moveHandle, rangeValid } from '../src/player/segmentMark';
import { createMarkBar } from '../src/player/markbar';

describe('segmentMark : calculs de la plage', () => {
  it('la plage de départ part de la lecture, sur 30 s, bornée à la durée', () => {
    expect(initialRange(120, 2600)).toEqual({ start: 120, end: 150 });
    expect(initialRange(2590, 2600)).toEqual({ start: 2590, end: 2600 });
    expect(initialRange(2599, 2600).start).toBeCloseTo(2597);
    expect(initialRange(NaN, 100)).toEqual({ start: 0, end: 30 });
  });

  it('une poignée ne passe jamais l’autre (3 s au moins) ni les bords', () => {
    const r = { start: 100, end: 130 };
    expect(moveHandle(r, 'start', 200, 600)).toEqual({ start: 127, end: 130 });
    expect(moveHandle(r, 'start', -5, 600)).toEqual({ start: 0, end: 130 });
    expect(moveHandle(r, 'end', 50, 600)).toEqual({ start: 100, end: 103 });
    expect(moveHandle(r, 'end', 9999, 600)).toEqual({ start: 100, end: 600 });
    expect(moveHandle(r, 'end', NaN, 600)).toBe(r);
  });

  it('propose le générique en fin d’épisode, l’intro sinon', () => {
    expect(guessKind({ start: 30, end: 90 }, 2600)).toBe('intro');
    expect(guessKind({ start: 2400, end: 2600 }, 2600)).toBe('credits');
  });

  it('valide à partir de 3 s', () => {
    expect(rangeValid({ start: 0, end: MARK_MIN })).toBe(true);
    expect(rangeValid({ start: 0, end: 2.9 })).toBe(false);
  });
});

function mount(send: (k: string, a: number, b: number) => Promise<boolean> = async () => true) {
  const opts = {
    getTime: () => 200,
    getDuration: () => 2600,
    onSend: vi.fn(send),
    onScrub: vi.fn(),
    onScrubEnd: vi.fn(),
    onClose: vi.fn(),
  };
  const bar = createMarkBar(opts);
  const seek = document.createElement('div');
  seek.append(bar.layer);
  document.body.append(seek, bar.pop);
  bar.layer.getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 28, right: 1000, bottom: 28, x: 0, y: 0, toJSON: () => ({}) });
  return { bar, opts, handle: (n: 's' | 'e') => bar.layer.querySelector('.lp-mk-h-' + n) as HTMLElement, q: (s: string) => bar.pop.querySelector(s) as HTMLElement };
}

afterEach(() => { document.body.innerHTML = ''; });

describe('marquage sur la barre', () => {
  it('s’ouvre sur la lecture et propose un type', () => {
    const m = mount();
    expect(m.bar.layer.hidden).toBe(true);
    m.bar.open(200);
    expect(m.bar.isOpen()).toBe(true);
    expect(m.q('.lp-mk-range').textContent).toBe('3:20 → 3:50');
    expect(m.q('.lp-mk-k.is-on').dataset.kind).toBe('intro');
    expect(m.handle('s').getAttribute('aria-valuenow')).toBe('200');
  });

  it('glisser une poignée règle la plage et aperçoit l’image', () => {
    const m = mount();
    m.bar.open(200);
    const h = m.handle('e');
    h.setPointerCapture = vi.fn();
    h.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0 }));
    h.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 150 })); // 150/1000 de 2600 s = 390 s
    expect(m.q('.lp-mk-range').textContent).toBe('3:20 → 6:30');
    expect(m.opts.onScrub).toHaveBeenLastCalledWith(390);
    h.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    expect(m.opts.onScrubEnd).toHaveBeenCalledWith(390);
  });

  it('les flèches déplacent d’1 s, avec Maj de 5 s', () => {
    const m = mount();
    m.bar.open(200);
    m.handle('s').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    m.handle('s').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    expect(m.handle('s').getAttribute('aria-valuenow')).toBe('206');
  });

  it('« Début = ici » prend la position de lecture, le type se corrige en un clic et Envoyer ferme', async () => {
    const m = mount();
    m.bar.open(500);
    (m.bar.pop.querySelectorAll('.lp-mk-here')[0] as HTMLElement).click();
    expect(m.q('.lp-mk-range').textContent?.startsWith('3:20')).toBe(true);
    (m.bar.pop.querySelector('.lp-mk-k[data-kind="recap"]') as HTMLElement).click();
    expect(m.q('.lp-mk-k.is-on').dataset.kind).toBe('recap');
    m.q('.lp-mk-send').click();
    await Promise.resolve(); await Promise.resolve();
    expect(m.opts.onSend).toHaveBeenCalledWith('recap', 200, 530);
    expect(m.bar.isOpen()).toBe(false);
    expect(m.opts.onClose).toHaveBeenCalledWith(true);
  });

  it('un envoi refusé laisse la barre ouverte pour réessayer', async () => {
    const m = mount(async () => false);
    m.bar.open(200);
    m.q('.lp-mk-send').click();
    await Promise.resolve(); await Promise.resolve();
    expect(m.bar.isOpen()).toBe(true);
    expect((m.q('.lp-mk-send') as HTMLButtonElement).disabled).toBe(false);
  });

  it('Annuler ferme sans rien envoyer', () => {
    const m = mount();
    m.bar.open(200);
    m.q('.lp-mk-cancel').click();
    expect(m.opts.onSend).not.toHaveBeenCalled();
    expect(m.bar.isOpen()).toBe(false);
  });

  it('les poignées annoncent leurs vraies bornes (3 s d’écart)', () => {
    const m = mount();
    m.bar.open(200);
    expect(m.handle('s').getAttribute('aria-valuemax')).toBe('227');
    expect(m.handle('e').getAttribute('aria-valuemin')).toBe('203');
    expect(m.handle('e').getAttribute('aria-valuemax')).toBe('2600');
  });

  it('un envoi qui échoue par exception rend la main au bouton', async () => {
    const m = mount(async () => { throw new Error('réseau'); });
    m.bar.open(200);
    m.q('.lp-mk-send').click();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(m.bar.isOpen()).toBe(true);
    expect((m.q('.lp-mk-send') as HTMLButtonElement).disabled).toBe(false);
  });

  it('ne s’ouvre pas sur un flux sans durée finie', () => {
    const bar = createMarkBar({ getTime: () => 0, getDuration: () => Infinity, onSend: async () => true, onScrub: () => {}, onScrubEnd: () => {}, onClose: () => {} });
    bar.open(0);
    expect(bar.isOpen()).toBe(false);
  });

  it('ne s’ouvre pas sans durée connue', () => {
    const opts = { getTime: () => 0, getDuration: () => 0, onSend: async () => true, onScrub: () => {}, onScrubEnd: () => {}, onClose: () => {} };
    const bar = createMarkBar(opts);
    bar.open(0);
    expect(bar.isOpen()).toBe(false);
  });
});
