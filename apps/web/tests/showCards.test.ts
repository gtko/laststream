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

type Show = {
  id: number | string; name: string; poster: string; backdrop: string; airings: Airing[]; platform: string; next: { date: string } | null; aliases: string[];
  epg?: boolean; icon?: string; category?: string;
  genres?: number[]; popularity?: number; overview?: string;
};
type Known = { id: number; name: string; poster: string; backdrop: string; aliases: string[] };
type Hero = { show: Show; airing: Airing | null; tonight: boolean };

let tonightTile: (a: Airing, known: Known | null, now: number) => string;
let showCard: (s: Show, now: number) => string;
let heroShow: (shows: Show[], now: number) => Hero | null;
let heroHTML: (h: Hero, now: number) => string;
let genreTabs: (shows: Show[]) => unknown[];
let ofGenre: (shows: Show[], genre: 'all' | number) => Show[];
let weekPicks: (shows: Show[], now: number, max?: number) => Show[];
let nextCardInner: (d: unknown, airings: Airing[], platform: string, pr: unknown, now: number) => string;
let dayWord: (sec: number, now: number) => string;

beforeAll(async () => {
  // Le module lit le DOM de l'application au chargement : on monte la page d'accueil comme les autres tests d'interface.
  const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  const mod = await import('../src/ui/shows.js');
  tonightTile = mod.tonightTile;
  showCard = mod.showCard;
  heroShow = mod.heroShow;
  heroHTML = mod.heroHTML;
  genreTabs = mod.genreTabs;
  ofGenre = mod.ofGenre;
  weekPicks = mod.weekPicks;
  nextCardInner = mod.nextCardInner;
  dayWord = mod.dayWord;
});

const at = (h: number, m: number) => new Date(2026, 9, 20, h, m).getTime() / 1000;
const DAY = 86400;
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

// ---- Page « Émissions TV » : héros, onglets de genre, incontournables (fonctions pures, heure injectée) ----
const show = (over: Partial<Show> = {}): Show => ({
  id: 1, name: 'Émission', poster: '', backdrop: '/b.jpg', airings: [], platform: '', next: null, aliases: [], genres: [], popularity: 0, overview: 'Synopsis.', ...over,
});

describe('« L’émission de la soirée » : héros', () => {
  it('prend la première émission (ordre de la page) diffusée entre 20 h 30 et 22 h, avec un fond', () => {
    const shows: Show[] = [
      show({ id: 1, name: 'Sans fond', backdrop: '', popularity: 999, airings: [airing(TF1, 'A', at(21, 0), at(22, 0))] }),
      show({ id: 2, name: 'Demain', popularity: 90, airings: [airing(TF1, 'B', at(21, 0) + DAY, at(22, 0) + DAY)] }),
      show({ id: 3, name: 'Tôt', popularity: 80, airings: [airing(M6, 'C', at(20, 0), at(20, 50))] }),
      show({ id: 4, name: 'Ce soir', popularity: 10, airings: [airing(M6, 'D', at(21, 10), at(22, 45))] }),
      show({ id: 5, name: 'Après 22 h', popularity: 70, airings: [airing(TF1, 'E', at(22, 0), at(23, 0))] }),
    ];
    const h = heroShow(shows, at(18, 0))!;
    expect(h.show.id).toBe(4);
    expect(h.tonight).toBe(true);
    expect(h.airing!.title).toBe('D');
  });

  it('à défaut, la plus populaire avec un fond ; null sans aucun fond', () => {
    const shows: Show[] = [
      show({ id: 1, backdrop: '', popularity: 999 }),
      show({ id: 2, popularity: 90, airings: [airing(TF1, 'B', at(21, 0) + DAY, at(22, 0) + DAY)] }),
      show({ id: 3, popularity: 80 }),
    ];
    const h = heroShow(shows, at(18, 0))!;
    expect(h.show.id).toBe(2);
    expect(h.tonight).toBe(false);
    expect(h.airing!.title).toBe('B');
    expect(heroShow([show({ backdrop: '' })], at(18, 0))).toBeNull();
  });

  it('ce soir : surtitre, titre h1 (cible du focus), diffusion, fiche et suivi', () => {
    const s = show({ id: 1003, name: 'Top Chef', overview: 'Cuisine.', airings: [airing(M6, 'Top Chef', at(21, 10), at(23, 15))] });
    const root = mountAll(heroHTML({ show: s, airing: s.airings[0], tonight: true }, at(21, 0)));
    expect(root.querySelector('.sv-kicker')!.textContent).toBe('L’émission de la soirée');
    const h1 = root.querySelector('h1')!;
    expect(h1.id).toBe('svc-title');
    expect(h1.getAttribute('tabindex')).toBe('-1');
    expect(h1.textContent).toBe('Top Chef');
    expect(root.querySelector('.sv-hero-line')!.textContent).toBe('Ce soir 21:10 · M6 · 2 h 05');
    expect(root.querySelector('.sv-hero-syn')!.textContent).toBe('Cuisine.');
    expect(root.querySelector('img')!.getAttribute('src')).toBe('https://image.tmdb.org/t/p/w1280/b.jpg');
    expect(root.querySelector('[data-showopen="1003"]')!.textContent).toContain('Voir la fiche');
    expect(root.querySelector('[data-showwatch]')).toBeNull();
    expect(root.querySelector('[data-follow="tv:1003"]')!.textContent).toContain('Me prévenir');
  });

  it('en direct : « Regarder en direct » à la place du suivi, ligne « En direct »', () => {
    const s = show({ id: 1001, name: 'La France a un incroyable talent', airings: [airing(TF1, 'LFAT', at(21, 10), at(23, 15))] });
    const root = mountAll(heroHTML({ show: s, airing: s.airings[0], tonight: true }, at(21, 30)));
    expect(root.querySelector('.sv-hero-line')!.textContent).toBe('En direct · TF1 · 2 h 05');
    expect(root.querySelector('[data-showwatch="fr:TF1.fr"]')!.textContent).toContain('Regarder en direct');
    expect(root.querySelector('[data-follow]')).toBeNull();
  });

  it('à la une : sans diffusion ce soir, la ligne reprend la plateforme et le prochain épisode', () => {
    const s = show({ id: 1002, name: 'LOL : qui rit, sort !', platform: 'Prime Video', next: { date: '2026-10-25' } });
    const root = mountAll(heroHTML({ show: s, airing: null, tonight: false }, at(21, 0)));
    expect(root.querySelector('.sv-kicker')!.textContent).toBe('À la une');
    expect(root.querySelector('.sv-hero-line')!.textContent).toContain('Prime Video');
    expect(root.querySelector('.sv-hero-syn')!.textContent).toBe('Synopsis.');
  });
});

describe('onglets de genre et incontournables', () => {
  it('onglets : seulement les genres présents, dans l’ordre voulu ; filtre par genre', () => {
    const shows: Show[] = [
      show({ id: 1, genres: [10764, 18] }),
      show({ id: 2, genres: [35] }),
      show({ id: 3, genres: [] }),
      show({ id: 4, genres: undefined }), // entrée mise en cache avant le champ genres
    ];
    expect(genreTabs(shows)).toEqual([[10764, 'Téléréalité'], [35, 'Divertissement']]);
    expect(ofGenre(shows, 'all')).toHaveLength(4);
    expect(ofGenre(shows, 10764).map((s) => s.id)).toEqual([1]);
    expect(ofGenre(shows, 99)).toEqual([]);
  });

  it('incontournables : les plus populaires avec une diffusion ou un épisode dans les 7 jours, six au plus', () => {
    const now = at(21, 0);
    const soon = show({ id: 1, popularity: 5, airings: [airing(TF1, 'A', now + 3 * DAY, now + 3 * DAY + 3600)] });
    const far = show({ id: 2, popularity: 99, airings: [airing(TF1, 'B', now + 9 * DAY, now + 9 * DAY + 3600)] });
    const next = show({ id: 3, popularity: 50, next: { date: '2026-10-22' } });
    const past = show({ id: 4, popularity: 70, next: { date: '2026-10-10' } });
    expect(weekPicks([far, soon, next, past], now).map((s) => s.id)).toEqual([3, 1]);
    const many = Array.from({ length: 8 }, (_, i) => show({ id: 10 + i, popularity: i, airings: [airing(TF1, 'X', now + DAY, now + DAY + 3600)] }));
    expect(weekPicks(many, now)).toHaveLength(6);
  });
});

describe('« Prochaine diffusion » : carte de la fiche', () => {
  const prov = (flat: string[], free: string[]) => ({
    flatrate: flat.map((name) => ({ name, logo: '' })), free: free.map((name) => ({ name, logo: '' })), rent: [], buy: [], link: '',
  });

  it('ce soir : jour, heure, chaîne, canal, durée et délai', () => {
    const a = airing(TF1, 'Talk', at(21, 10), at(23, 15));
    const root = mountAll(nextCardInner({ next: null }, [a], '', null, at(18, 0)));
    expect(root.querySelector('.sf-next-k')!.textContent).toBe('Prochaine diffusion');
    expect(root.querySelector('.sf-next-big')!.textContent).toBe('Ce soir 21:10');
    expect(root.querySelector('.sf-next-sub')!.textContent).toBe('TF1 · canal 1 · 2 h 05');
    expect(root.querySelector('.sf-next-acc')!.textContent).toBe('Dans 3 h 10 min');
    expect(root.querySelector('.sf-bar')).toBeNull();
    expect(root.querySelector('.sf-next-where')).toBeNull();
  });

  it('en direct : heure de fin et barre de progression', () => {
    const a = airing(TF1, 'Talk', at(21, 10), at(23, 15));
    const root = mountAll(nextCardInner({ next: null }, [a], '', null, at(21, 30)));
    expect(root.querySelector('.sf-next-acc')!.textContent).toBe('En direct jusqu’à 23:15');
    expect(root.querySelector('.sf-bar > span')!.getAttribute('style')).toBe('width:16%');
  });

  it('demain et plus tard : « Demain » ou jour de la semaine ; replay selon les fournisseurs', () => {
    const now = at(18, 0);
    const tomorrow = airing(M6, 'Talk', at(21, 10) + DAY, at(22, 0) + DAY);
    const r1 = mountAll(nextCardInner({ next: null }, [tomorrow], '', prov([], ['TF1+']), now));
    expect(r1.querySelector('.sf-next-big')!.textContent).toBe('Demain 21:10');
    expect(r1.querySelector('.sf-next-sub')!.textContent).toBe('M6 · canal 6 · 50 min');
    expect(r1.querySelector('.sf-next-where')!.textContent).toBe('Replay sur TF1+');
    const later = airing(M6, 'Talk', at(21, 10) + 3 * DAY, at(22, 0) + 3 * DAY);
    const r2 = mountAll(nextCardInner({ next: null }, [later], '', null, now));
    expect(r2.querySelector('.sf-next-big')!.textContent).toMatch(/^(Lundi|Mardi|Mercredi|Jeudi|Vendredi|Samedi|Dimanche) \d{1,2} 21:10$/);
    expect(dayWord(at(21, 10), at(9, 0))).toBe('Ce soir');
    expect(dayWord(at(9, 30), at(8, 0))).toBe('Aujourd’hui');
  });

  it('sans diffusion : nouvel épisode avec la plateforme, plateforme seule, sinon carte vide', () => {
    const next = { season: 3, episode: 1, name: 'Nouvelle saison', date: '2026-10-25', still: '', runtime: 0, overview: '' };
    const r = mountAll(nextCardInner({ next }, [], 'Prime Video', prov(['Prime Video'], []), at(18, 0)));
    expect(r.querySelector('.sf-next-k')!.textContent).toBe('Nouvel épisode');
    expect(r.querySelector('.sf-next-big')!.textContent).toBe('25 octobre');
    expect(r.querySelector('.sf-next-sub')!.textContent).toBe('S3 · É1');
    expect(r.querySelector('.sf-next-where')!.textContent).toBe('Streaming sur Prime Video');
    const plat = mountAll(nextCardInner({ next: null }, [], 'Prime Video', null, at(18, 0)));
    expect(plat.querySelector('.sf-next-big')!.textContent).toBe('Prime Video');
    expect(nextCardInner({ next: null }, [], '', null, at(18, 0))).toBe('');
  });
});

// ---- Émission du guide sans fiche TMDB : affiche (image du guide ou fond typographique) et genre au guide ----
describe('émission du guide sans fiche TMDB', () => {
  const epg = (over: Partial<Show> = {}): Show => ({
    id: 'epg:les-enquetes', name: 'Les Enquêtes', poster: '', backdrop: '', airings: [airing(TF1, 'Les Enquêtes', at(21, 0), at(22, 0))], platform: '', next: null,
    aliases: [], epg: true, icon: 'https://img.example/enq.jpg', category: 'Magazine d’information', ...over,
  });

  it('affiche : image du guide rognée en 2:3, identifiant « epg: » pour la fiche', () => {
    const card = mount(showCard(epg(), at(20, 0)));
    expect(card.getAttribute('data-showopen')).toBe('epg:les-enquetes');
    expect(card.querySelector('.card-media img')!.getAttribute('src')).toBe('https://img.example/enq.jpg');
    expect(card.querySelector('.card-media img')!.getAttribute('style')).toContain('object-fit:cover');
    expect(card.querySelector('.card-media')!.classList.contains('no-img')).toBe(false);
  });

  it('sans image du guide, ou avec une adresse qui n’est pas web : fond typographique', () => {
    const none = mount(showCard(epg({ icon: '' }), at(20, 0)));
    expect(none.querySelector('.card-media img')).toBeNull();
    expect(none.querySelector('.card-media')!.classList.contains('no-img')).toBe(true);
    expect(none.querySelector('.card-fallback .tp-title')!.textContent).toBe('Les Enquêtes');
    const odd = mount(showCard(epg({ icon: 'javascript:alert(1)' }), at(20, 0)));
    expect(odd.querySelector('.card-media img')).toBeNull();
  });

  it('échappe le titre et l’adresse de l’image', () => {
    const card = mount(showCard(epg({ name: 'Q&A "<b>x</b>"', icon: 'https://img.example/a.jpg?x="><script>' }), at(20, 0)));
    expect(card.querySelector('script')).toBeNull();
    expect(card.querySelector('b')).toBeNull();
    expect(card.querySelector('.card-title')!.textContent).toBe('Q&A "<b>x</b>"');
    expect(card.querySelector('.card-media img')!.getAttribute('src')).toBe('https://img.example/a.jpg?x="><script>');
  });

  it('genre au guide : la catégorie range l’émission dans l’onglet correspondant', () => {
    const table: Array<[string, number, string]> = [
      ['Téléréalité', 10764, 'Téléréalité'], ['Talk-show', 10767, 'Talk-shows'], ['Jeu', 35, 'Divertissement'], ['Variétés', 35, 'Divertissement'],
      ['Magazine d’information', 10763, 'Magazines et actu'], ['Documentaire', 99, 'Documentaires'],
    ];
    table.forEach(([cat, id, label]) => {
      expect(genreTabs([epg({ category: cat })]), cat).toEqual([[id, label]]);
    });
    expect(ofGenre([epg({ category: 'Documentaire' })], 99)).toHaveLength(1);
    expect(ofGenre([epg({ category: 'Documentaire' })], 35)).toEqual([]);
  });
});

/** Monte un HTML de section complet (pas une carte) et renvoie son conteneur. */
function mountAll(html: string): HTMLElement {
  document.body.innerHTML = '<div id="host">' + html + '</div>';
  return document.getElementById('host') as HTMLElement;
}
