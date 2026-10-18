// Cartes des rangées d'accueil : « Ce soir à la TV » (paysage 16:9) et « Émissions du moment » (affiche), rendues à une heure injectée.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Airing, GuideChannel } from '../src/data/shows';

vi.mock('hls.js', () => {
  class FakeHls {
    static isSupported = () => true;
    static Events = { FRAG_LOADED: 'f', ERROR: 'e', MANIFEST_PARSED: 'm' };
    static ErrorTypes = { NETWORK_ERROR: 'n', MEDIA_ERROR: 'd' };
    on() { /* ignoré */ }
    loadSource() { /* ignoré */ }
    attachMedia() { /* ignoré */ }
    startLoad() { /* ignoré */ }
    destroy() { /* ignoré */ }
  }
  return { default: FakeHls };
});

type Show = { id: number; name: string; poster: string; backdrop: string; airings: Airing[]; platform: string; next: null; aliases: string[] };
type Known = { id: number; name: string; poster: string; backdrop: string; aliases: string[] };

let tonightTile: (a: Airing, known: Known | null, now: number) => string;
let showCard: (s: Show, now: number) => string;

beforeAll(async () => {
  // Le module lit le DOM de l'application au chargement : on monte la page d'accueil comme les autres tests d'interface.
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  const mod = await import('../src/ui/shows.js');
  tonightTile = mod.tonightTile;
  showCard = mod.showCard;
});

const at = (h: number, m: number) => new Date(2026, 9, 20, h, m).getTime() / 1000;
const TF1: GuideChannel = { epgId: 'fr:TF1.fr', playId: 'fr:TF1.fr', name: 'TF1', logo: 'https://logo.example/tf1.png', num: 1 };
const M6: GuideChannel = { epgId: 'fr:M6.fr', playId: 'fr:M6.fr', name: 'M6', logo: '', num: 6 };
const airing = (channel: GuideChannel, title: string, start: number, stop: number, category = 'Divertissement', icon = ''): Airing =>
  ({ channel, start, stop, title, desc: '', icon, category });

/** Rend un HTML de carte et le place dans le document pour l'interroger. */
function mount(html: string): HTMLElement {
  document.body.innerHTML = '';
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host.querySelector('.card') as HTMLElement;
}

describe('« Ce soir à la TV » : carte paysage', () => {
  it('heure en grand, durée, chaîne en pastille, titre et genre', () => {
    const card = mount(tonightTile(airing(M6, 'Zone interdite', at(21, 10), at(22, 45)), null, at(20, 0)));
    expect(card.classList.contains('tile-land')).toBe(true);
    expect(card.querySelector('.tn-time')!.textContent).toBe('21:10');
    expect(card.querySelector('.tn-dur')!.textContent).toBe('1 h 35');
    expect(card.querySelector('.tn-title')!.textContent).toBe('Zone interdite');
    expect(card.querySelector('.tn-sub')!.textContent).toBe('Divertissement');
    expect(card.querySelector('.tn-chan .ch-num')!.textContent).toBe('6');
    expect(card.querySelector('.tn-chan .tn-name')!.textContent).toBe('M6'); // pas de logo : le nom de la chaîne
    expect(card.getAttribute('aria-label')).toBe('Zone interdite, M6, 21:10');
    expect(card.getAttribute('data-showwatch')).toBe('fr:M6.fr');
  });

  it('chaîne avec logo : le logo remplace le nom en pastille', () => {
    const card = mount(tonightTile(airing(TF1, 'Journal', at(20, 50), at(21, 0), ''), null, at(20, 0)));
    expect(card.querySelector('.tn-chan .tn-logo')!.getAttribute('src')).toBe('https://logo.example/tf1.png');
    expect(card.querySelector('.tn-name')).toBeNull();
    expect(card.querySelector('.tn-sub')).toBeNull(); // pas de genre au guide : pas de ligne vide
    expect(card.querySelector('.tn-dur')!.textContent).toBe('10 min');
  });

  it('en direct à l’heure injectée : badge accent et progression, sinon ni l’un ni l’autre', () => {
    const live = airing(TF1, 'La France a un incroyable talent', at(21, 10), at(22, 45));
    const onAir = mount(tonightTile(live, null, at(21, 30))); // 20 min sur 95
    expect(onAir.querySelector('.show-live')!.textContent).toBe('En direct');
    expect(onAir.querySelector('.progress > span')!.getAttribute('style')).toBe('width:21%');
    expect(onAir.getAttribute('aria-label')).toBe('La France a un incroyable talent, TF1, 21:10, en direct');
    expect(onAir.classList.contains('is-live')).toBe(true);

    const before = mount(tonightTile(live, null, at(20, 0)));
    expect(before.querySelector('.show-live')).toBeNull();
    expect(before.querySelector('.progress')).toBeNull();

    const ended = mount(tonightTile(live, null, at(22, 45))); // l'heure de fin n'est plus « en cours »
    expect(ended.querySelector('.show-live')).toBeNull();
  });

  it('image : fond TMDB de l’émission connue, sinon image du guide, sinon fond typographique', () => {
    const known: Known = { id: 1003, name: 'Top Chef', poster: '/tc.jpg', backdrop: '/tcb.jpg', aliases: [] };
    const withFond = mount(tonightTile(airing(M6, 'Top Chef', at(21, 0), at(22, 0)), known, at(20, 0)));
    expect(withFond.querySelector('img')!.getAttribute('src')).toBe('https://image.tmdb.org/t/p/w780/tcb.jpg');
    expect(withFond.getAttribute('data-showopen')).toBe('1003');
    expect(withFond.querySelector('.card-media')!.classList.contains('no-img')).toBe(false);

    // Pas de fond TMDB (affiche seule, pas de paysage) : l'image du guide sert de fond.
    const noBackdrop: Known = { ...known, backdrop: '' };
    const guideImg = mount(tonightTile(airing(M6, 'Top Chef', at(21, 0), at(22, 0), 'Divertissement', 'https://guide.example/icon.jpg'), noBackdrop, at(20, 0)));
    expect(guideImg.querySelector('img')!.getAttribute('src')).toBe('https://guide.example/icon.jpg');

    const none = mount(tonightTile(airing(M6, 'Zone interdite', at(21, 10), at(22, 45)), null, at(20, 0)));
    expect(none.querySelector('img')).toBeNull();
    expect(none.querySelector('.card-media')!.classList.contains('no-img')).toBe(true);
    expect(none.querySelector('.card-fallback .tp-title')!.textContent).toBe('Zone interdite'); // typo du repli
    expect(none.querySelector('.card-fallback.tp')).not.toBeNull();
  });

  it('échappe les textes issus du guide (titre, chaîne, genre)', () => {
    const evil = '<img src=x onerror="alert(1)"> & Co';
    const chan: GuideChannel = { epgId: 'x', playId: null, name: 'A&B <b>', logo: '', num: null };
    const card = mount(tonightTile(airing(chan, evil, at(21, 0), at(22, 0), '<i>Film</i>'), null, at(20, 0)));
    expect(card.querySelector('img[onerror]')).toBeNull();
    expect(card.querySelector('b:not(.ch-num)')).toBeNull();
    expect(card.querySelector('.tn-title')!.textContent).toBe(evil);
    expect(card.querySelector('.tn-sub')!.textContent).toBe('<i>Film</i>');
    expect(card.getAttribute('aria-label')).toBe(evil + ', A&B <b>, 21:00');
  });
});

describe('« Émissions du moment » : affiche', () => {
  const show = (over: Partial<Show> = {}): Show => ({ id: 1001, name: 'La France a un incroyable talent', poster: '/lf.jpg', backdrop: '/lfb.jpg', airings: [], platform: '', next: null, aliases: [], ...over });

  it('affiche 2:3 avec titre et diffusion sous l’image', () => {
    const now = at(21, 30);
    const card = mount(showCard(show({ airings: [airing(TF1, 'La France a un incroyable talent', now - 600, now + 3600)] }), now));
    expect(card.getAttribute('data-showopen')).toBe('1001');
    expect(card.querySelector('.card-media img')!.getAttribute('src')).toBe('https://image.tmdb.org/t/p/w342/lf.jpg');
    expect(card.querySelector('.card-media')!.classList.contains('no-img')).toBe(false);
    expect(card.querySelector('.card-title')!.textContent).toBe('La France a un incroyable talent');
    expect(card.querySelector('.card-meta')!.textContent).toBe('En direct · TF1');
    expect(card.querySelector('.show-live')!.textContent).toBe('En direct');
    expect(card.getAttribute('aria-label')).toBe('La France a un incroyable talent, En direct · TF1');
  });

  it('sans affiche : fond typographique au nom de l’émission, titre dessous conservé', () => {
    const card = mount(showCard(show({ poster: '', platform: 'Prime Video' }), at(21, 30)));
    expect(card.querySelector('.card-media')!.classList.contains('no-img')).toBe(true);
    expect(card.querySelector('.card-media img')).toBeNull();
    expect(card.querySelector('.card-fallback .tp-title')!.textContent).toBe('La France a un incroyable talent');
    expect(card.querySelector('.card-title')!.textContent).toBe('La France a un incroyable talent');
    expect(card.querySelector('.card-meta')!.textContent).toBe('Prime Video');
    expect(card.querySelector('.show-live')).toBeNull();
  });

  it('échappe le nom de l’émission', () => {
    const card = mount(showCard(show({ name: 'Q&A "<script>"', poster: '' }), at(21, 30)));
    expect(card.querySelector('script')).toBeNull();
    expect(card.querySelector('.card-title')!.textContent).toBe('Q&A "<script>"');
    expect(card.getAttribute('aria-label')).toBe('Q&A "<script>", Émission');
  });
});
