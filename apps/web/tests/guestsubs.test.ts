// Sous-titres de l'hôte côté invité (src/ui/guestsubs.js) : pistes du salon, menu, cue active selon la position,
// échappement du texte, langue mémorisée, stockage indisponible. Le VTT passe par parseCues (src/player/subs.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanTracks, createGuestSubs, SUBS_KEY } from '../src/ui/guestsubs.js';
import { createGuestControls } from '../src/ui/guestplayer.js';

type Any = any;

const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour\n\n00:00:03.000 --> 00:00:04.500\nAu revoir\n\n';
const FR = { id: 's1', lang: 'fr', label: 'Français', vtt: VTT };
const EN = { id: 's2', lang: 'en', label: 'English', vtt: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n\n' };

let stages: HTMLElement[] = [];
let controls: Any[] = [];
let subsList: Any[] = [];

afterEach(() => {
  for (const s of subsList) s.destroy();
  for (const c of controls) c.destroy();
  for (const s of stages) s.remove();
  stages = [];
  controls = [];
  subsList = [];
  localStorage.clear();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function setup(onOpen?: () => void) {
  const stage = document.createElement('div');
  document.body.appendChild(stage);
  stages.push(stage);
  const c = createGuestControls(stage, {});
  controls.push(c);
  const subs = createGuestSubs(c, onOpen ? { onOpen } : {});
  subsList.push(subs);
  const layer = stage.querySelector('.gp-subs') as HTMLElement;
  const btn = stage.querySelector('[data-id="subs"]') as HTMLButtonElement;
  const pop = stage.querySelector('.gs-pop') as HTMLElement;
  const items = () => Array.from(pop.querySelectorAll('.gs-item')) as HTMLButtonElement[];
  const choose = (label: string) => {
    const item = items().find((b) => b.querySelector('.gs-label')?.textContent === label);
    if (!item) throw new Error('entrée absente : ' + label);
    item.click();
  };
  return { stage, subs, layer, btn, pop, items, choose };
}

describe('pistes du salon', () => {
  it('sans piste : bouton masqué et rien à l’écran', () => {
    const { subs, btn, layer } = setup();
    expect(btn.hidden).toBe(true);
    subs.setTracks([FR]);
    expect(btn.hidden).toBe(false);
    subs.setTracks([]);
    expect(btn.hidden).toBe(true);
    expect(layer.textContent).toBe('');
  });

  it('le menu liste « Désactivés » puis une entrée par piste, libellés en texte', () => {
    const { subs, btn, pop, items } = setup();
    subs.setTracks([FR, { id: 's3', lang: 'de', label: '<b>Gras</b>', vtt: VTT }]);
    btn.click();
    expect(pop.hidden).toBe(false);
    expect(items().map((b) => b.querySelector('.gs-label')?.textContent)).toEqual(['Désactivés', 'Français', '<b>Gras</b>']);
    expect(pop.querySelector('b')).toBeNull();
  });

  it('cleanTracks : pistes mal formées écartées, 8 au plus, libellé de repli sur la langue', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: 'x' + i, lang: 'fr', label: '', vtt: VTT }));
    expect(cleanTracks(many)).toHaveLength(8);
    expect(cleanTracks(many)[0].label).toBe('fr');
    expect(cleanTracks([{ id: 'a', lang: 'fr', label: 'A' }, null, { id: '', vtt: VTT }, { id: 'b', vtt: 42 }])).toEqual([]);
    expect(cleanTracks('pas une liste' as Any)).toEqual([]);
  });

  it('le calque reprend les classes du lecteur principal (couleur, fond, taille)', () => {
    const { layer } = setup();
    expect(layer.classList.contains('lp-subs')).toBe(true);
    expect(layer.classList.contains('c-white')).toBe(true);
    expect(layer.classList.contains('bg-shadow')).toBe(true);
    expect(layer.style.getPropertyValue('--subsize')).toBe('1');
  });
});

describe('cue active', () => {
  it('la cue affichée suit la position de lecture, et rien hors cue', () => {
    const { subs, btn, layer, choose } = setup();
    subs.setTracks([FR]);
    btn.click();
    choose('Français');
    subs.tick(0.5);
    expect(layer.textContent).toBe('');
    subs.tick(1.5);
    expect(layer.textContent).toBe('Bonjour');
    subs.tick(2.5);
    expect(layer.textContent).toBe('');
    subs.tick(3.6);
    expect(layer.textContent).toBe('Au revoir');
  });

  it('le choix est visible dans le menu (coche sur la piste active)', () => {
    const { subs, btn, items, choose } = setup();
    subs.setTracks([FR, EN]);
    btn.click();
    choose('English');
    btn.click();
    const checked = items().filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.querySelector('.gs-label')?.textContent);
    expect(checked).toEqual(['English']);
  });

  it('une cue au texte piégé n’insère ni image ni attribut : le texte seul reste', () => {
    const piege = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<img src=x onerror="window.__pwn=1">Salut\n\n';
    const { subs, btn, layer, choose } = setup();
    subs.setTracks([{ id: 'p', lang: 'fr', label: 'Piège', vtt: piege }]);
    btn.click();
    choose('Piège');
    subs.tick(1.2);
    expect(layer.querySelector('img')).toBeNull();
    expect(layer.textContent).toContain('Salut');
    expect((window as Any).__pwn).toBeUndefined();
  });
});

describe('choix mémorisé', () => {
  it('le choix est écrit dans le stockage local ; « Désactivés » l’efface', () => {
    const { subs, btn, layer, choose } = setup();
    subs.setTracks([FR]);
    btn.click();
    choose('Français');
    expect(localStorage.getItem(SUBS_KEY)).toBe('fr');
    subs.tick(1.5);
    expect(layer.textContent).toBe('Bonjour');

    btn.click();
    choose('Désactivés');
    expect(localStorage.getItem(SUBS_KEY)).toBe('');
    expect(layer.textContent).toBe('');
  });

  it('au prochain salon, la langue précédemment choisie est active d’office', () => {
    localStorage.setItem(SUBS_KEY, 'en');
    const { subs, layer } = setup();
    subs.setTracks([FR, EN]);
    subs.tick(1.5);
    expect(layer.textContent).toBe('Hello');
  });

  it('une langue mémorisée absente de la liste n’est pas activée', () => {
    localStorage.setItem(SUBS_KEY, 'de');
    const { subs, layer } = setup();
    subs.setTracks([FR, EN]);
    subs.tick(1.5);
    expect(layer.textContent).toBe('');
    expect(localStorage.getItem(SUBS_KEY)).toBe('de');
  });

  it('stockage refusé : aucune erreur, le choix vaut pour la page', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const { subs, btn, layer, choose } = setup();
    expect(() => subs.setTracks([FR])).not.toThrow();
    btn.click();
    expect(() => choose('Français')).not.toThrow();
    subs.tick(1.5);
    expect(layer.textContent).toBe('Bonjour');
  });
});

describe('menu', () => {
  it('ouverture prévient onOpen ; clic hors du menu le referme', () => {
    const onOpen = vi.fn();
    const { subs, btn, pop } = setup(onOpen);
    subs.setTracks([FR]);
    btn.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(pop.hidden).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(pop.hidden).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('le menu ne s’ouvre pas sans piste', () => {
    const { btn, pop } = setup();
    btn.click();
    expect(pop.hidden).toBe(true);
  });
});

describe('Échap', () => {
  /** Écouteur de bulle sur document, comme le gestionnaire global de la page (events.js) qui quitte la page. */
  function globalKeydown() {
    const fn = vi.fn();
    document.addEventListener('keydown', fn);
    return { fn, off: () => document.removeEventListener('keydown', fn) };
  }
  const escape = (target: EventTarget) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

  it('ferme le menu, focus sur son bouton, sans remonter au gestionnaire global', () => {
    const global = globalKeydown();
    try {
      const { subs, btn, pop } = setup();
      subs.setTracks([FR]);
      btn.click();
      expect(pop.hidden).toBe(false);
      escape(btn);
      expect(pop.hidden).toBe(true);
      expect(btn.getAttribute('aria-expanded')).toBe('false');
      expect(global.fn).not.toHaveBeenCalled();
    } finally {
      global.off();
    }
  });

  it('menu fermé : Échap suit son cours et atteint le gestionnaire global', () => {
    const global = globalKeydown();
    try {
      const { subs, btn } = setup();
      subs.setTracks([FR]);
      escape(btn);
      expect(global.fn).toHaveBeenCalledTimes(1);
    } finally {
      global.off();
    }
  });
});
