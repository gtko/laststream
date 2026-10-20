// Émissions TV : rapprochement titres/guide (unitaire), puis page, fiche, rangées d'accueil et calendrier (jsdom, fetch simulé).
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { airingsFor, dayLabel, hhmm, localDate, matchKnown, primeTime, programKeys, titleKey, titleMatches, type EpgProgram, type GuideChannel } from '../src/data/shows';
import { playBest } from '../src/player/session.js';
import { state } from '../src/ui/state.js';
// Lecture d'un épisode : on vérifie l'appel (sources, auto-lecture) sans lancer de vrai lecteur. Stubs complets (pas de
// importOriginal) : le vrai module tire les rangées et la fiche dans un cycle d'imports qui garde le vrai playBest.
vi.mock('../src/player/session.js', () => ({
  playBest: vi.fn(async () => undefined),
  closePlayer: () => undefined,
  isPlayerOpen: () => false,
}));

const hlsLoads: string[] = [];
vi.mock('hls.js', () => {
  class FakeHls {
    static isSupported = () => true;
    static Events = { FRAG_LOADED: 'f', ERROR: 'e', MANIFEST_PARSED: 'm' };
    static ErrorTypes = { NETWORK_ERROR: 'n', MEDIA_ERROR: 'd' };
    on() { /* ignoré */ }
    loadSource(u: string) { hlsLoads.push(u); }
    attachMedia() { /* ignoré */ }
    startLoad() { /* ignoré */ }
    destroy() { /* ignoré */ }
  }
  return { default: FakeHls };
});

describe('rapprochement des titres du guide', () => {
  it('normalise accents, casse, articles et suffixes Saison / Épisode', () => {
    expect(titleKey('La France a un incroyable talent')).toBe('france a un incroyable talent');
    expect(programKeys('La France a un Incroyable Talent - Saison 17 Episode 3')).toContain('france a un incroyable talent');
    expect(programKeys('Koh-Lanta (Inédit) S12E4')).toContain('koh lanta');
    expect(programKeys('Top Chef : la finale')).toContain('top chef');
  });

  it('reconnaît une émission sous ses variantes de titre', () => {
    expect(titleMatches('LA FRANCE A UN INCROYABLE TALENT - Saison 17 Episode 3', 'La France a un incroyable talent')).toBe(true);
    expect(titleMatches('Koh-Lanta : Les armes secrètes', 'Koh-Lanta')).toBe(true);
    expect(titleMatches('Koh Lanta', 'Koh-Lanta')).toBe(true);
    expect(titleMatches('Quotidien', 'Quotidien')).toBe(true);
    expect(titleMatches('Questions pour un champion', 'Questions pour un champion')).toBe(true);
    expect(titleMatches('Incroyable talent', 'La France a un incroyable talent', ['Incroyable talent'])).toBe(true);
    expect(titleMatches('Top Cher', 'Top Chef')).toBe(false); // trop court pour la tolérance aux coquilles
    expect(titleMatches('Fort Boyard : la finale', 'Fort Boyard')).toBe(true);
    expect(titleMatches('Slam story', 'Slam')).toBe(false); // nom court : égalité stricte
    expect(titleMatches('Le Journal du soir', 'Quotidien')).toBe(false);
  });

  it('liste les diffusions en cours et à venir, du plus proche au plus lointain', () => {
    const tf1: GuideChannel = { epgId: 'fr:TF1.fr', playId: 'fr:TF1.fr', name: 'TF1', logo: '', num: 1 };
    const m6: GuideChannel = { epgId: 'fr:M6.fr', playId: 'fr:M6.fr', name: 'M6', logo: '', num: 6 };
    const by = new Map([[tf1.epgId, tf1], [m6.epgId, m6]]);
    const now = 1_800_000_000;
    const progs: EpgProgram[] = [
      { channelId: 'fr:M6.fr', start: now + 7200, stop: now + 10000, title: 'Top Chef' },
      { channelId: 'fr:TF1.fr', start: now - 600, stop: now + 1200, title: 'Top Chef - Saison 15 Episode 2' },
      { channelId: 'fr:TF1.fr', start: now - 9000, stop: now - 6000, title: 'Top Chef' }, // terminé
      { channelId: 'fr:TF1.fr', start: now + 50, stop: now + 100, title: 'Météo' },
    ];
    const out = airingsFor({ name: 'Top Chef' }, progs, (p) => by.get(p.channelId), now);
    expect(out.map((a) => a.channel.name)).toEqual(['TF1', 'M6']);
    expect(matchKnown('Top Chef - Épisode 3', [{ name: 'Koh-Lanta' }, { name: 'Top Chef' }])?.name).toBe('Top Chef');
  });

  it('ce soir : un programme par chaîne entre 20 h 45 et 22 h 45, hors météo et journaux', () => {
    const date = '2026-10-20';
    const at = (h: number, m: number) => new Date(2026, 9, 20, h, m).getTime() / 1000;
    const ch = (n: number, name: string): GuideChannel => ({ epgId: name, playId: name, name, logo: '', num: n });
    const chans = new Map([['A', ch(1, 'A')], ['B', ch(2, 'B')], ['C', ch(3, 'C')]]);
    const progs: EpgProgram[] = [
      { channelId: 'A', start: at(20, 0), stop: at(20, 50), title: 'Le 20h' },
      { channelId: 'A', start: at(20, 55), stop: at(23, 0), title: 'Film A' },
      { channelId: 'B', start: at(20, 30), stop: at(20, 45), title: 'Météo' },
      { channelId: 'B', start: at(20, 45), stop: at(22, 0), title: 'Jeu B' },
      { channelId: 'B', start: at(22, 0), stop: at(23, 30), title: 'Talk B' },
      { channelId: 'C', start: at(15, 0), stop: at(16, 0), title: 'Après-midi' },
    ];
    const out = primeTime(progs, (p) => chans.get(p.channelId), date);
    expect(out.map((a) => a.title)).toEqual(['Film A', 'Jeu B']);
    expect(hhmm(at(21, 5))).toBe('21:05');
    expect(localDate(at(21, 5))).toBe(date);
    expect(dayLabel(at(21, 5), at(9, 0))).toBe('Aujourd’hui');
    expect(dayLabel(at(21, 5) + 86400, at(9, 0))).toBe('Demain');
  });
});

// ---- Interface ----
const now = Math.floor(Date.now() / 1000);
const fra = [{ code: 'fra', name: 'français' }];
const ch = (id: string, name: string) => ({
  id, name, logo: '', group: 'France', cat: 'Généraliste', source: 'freetv', fast: false, url: 'https://up.example/' + id + '.m3u8', epgId: id.replace(/^fr:/, ''), flaky: false,
  country: 'FR', languages: fra, categories: [{ id: 'generaliste', label: 'Généraliste' }], reliability: 'high', alternatives: [], sig: 'SIG_' + id.replace(/\W/g, ''),
});
const CHANNELS = [ch('fr:France3.fr', 'France 3'), ch('fr:M6.fr', 'M6'), ch('fr:TF1.fr', 'TF1')];

function primeAt(dayOffset: number): [number, number] {
  const d = new Date();
  return [new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, 20, 50).getTime() / 1000, new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, 22, 50).getTime() / 1000];
}

const calls: string[] = [];
function mockFetch(url: string): Response {
  calls.push(url);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const u = new URL(url);
  const p = u.pathname;
  if (p.endsWith('/lt/tv/channels')) return json({ total: CHANNELS.length, page: 1, limit: 500, channels: CHANNELS });
  if (p.endsWith('/lt/tv/facets')) return json({ total: 3, countries: [{ code: 'FR', name: 'France', count: 3 }], languages: [{ code: 'fra', name: 'français', count: 3 }], categories: [], sources: [] });
  if (p.endsWith('/lt/tv/epg')) {
    const ids = String(u.searchParams.get('ids') || '').split(',').filter(Boolean);
    const out: unknown[] = [];
    ids.forEach((id) => {
      [0, 1].forEach((off) => {
        const [s, e] = primeAt(off);
        const title = id === 'fr:M6.fr' ? 'Top Chef - Saison 15 Episode 2' : 'Film du soir ' + id;
        out.push({ channelId: id, start: s, stop: e, title, desc: 'Résumé.', icon: '', category: 'Divertissement' });
      });
      if (id === 'fr:TF1.fr') out.push({ channelId: id, start: now - 1200, stop: now + 2400, title: 'La France a un incroyable talent - Saison 17 Episode 3', desc: 'Les auditions.', icon: '', category: 'Divertissement' });
    });
    return json(out);
  }
  if (p.endsWith('/lt/tmdb/discover/tv')) {
    return json({ results: [
      { id: 1001, name: 'La France a un incroyable talent', poster_path: '/lf.jpg', backdrop_path: '/lfb.jpg', popularity: 80, overview: 'Le télécrochet.', genre_ids: [10764] },
      { id: 1002, name: 'LOL : qui rit, sort !', poster_path: '/lol.jpg', backdrop_path: '/lolb.jpg', popularity: 60, overview: 'Qui rit sort.', genre_ids: [35] },
    ] });
  }
  if (p.endsWith('/lt/tmdb/search/tv')) {
    return json({ results: [{ id: 1003, name: 'Top Chef', poster_path: '/tc.jpg', backdrop_path: '/tcb.jpg', popularity: 30, origin_country: ['FR'], overview: 'Cuisine.', genre_ids: [10764] }] });
  }
  const watch = /\/lt\/tmdb\/tv\/(\d+)\/watch\/providers$/.exec(p);
  if (watch) return json({ results: { FR: watch[1] === '1002' ? { flatrate: [{ provider_name: 'Prime Video', logo_path: '/pv.jpg', display_priority: 1 }], link: 'https://tmdb.example/x' } : {} } });
  const season = /\/lt\/tmdb\/tv\/(\d+)\/season\/(\d+)$/.exec(p);
  if (season) return json({ episodes: [
    { episode_number: 1, name: 'Auditions 1', air_date: '2026-09-01', runtime: 0, overview: '', still_path: null },
    { episode_number: 2, name: 'Auditions 2', air_date: '2026-09-08', runtime: 52, overview: 'Deuxième.', still_path: '/s2.jpg' },
    { episode_number: 3, name: 'Futur', air_date: '2999-01-01', runtime: 50, overview: '', still_path: null },
  ] });
  const tvd = /\/lt\/tmdb\/tv\/(\d+)$/.exec(p);
  if (tvd) {
    const next = tvd[1] === '1002' ? { air_date: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10), season_number: 3, episode_number: 1, name: 'Nouvelle saison' } : null;
    const last = tvd[1] === '1002' ? { air_date: '2026-09-08', season_number: 1, episode_number: 2, name: 'Auditions 2', runtime: 52 } : null;
    const genres = { 1001: [{ id: 10764, name: 'Téléréalité' }], 1002: [{ id: 35, name: 'Divertissement' }] }[tvd[1]] || [];
    // Animateur en premier (rôle d'hôte) : « Présenté par » ; la seconde n'a pas de photo : initiales.
    const credits = tvd[1] === '1001' ? { cast: [
      { id: 11, name: 'Animateur Test', character: 'Himself - Host', profile_path: '/a.jpg' },
      { id: 12, name: 'Chroniqueuse Test', character: 'Himself - Jury', profile_path: null },
    ] } : { cast: [] };
    return json({ id: Number(tvd[1]), name: { 1001: 'La France a un incroyable talent', 1002: 'LOL : qui rit, sort !', 1003: 'Top Chef' }[tvd[1]] || 'Série', overview: 'Synopsis de l’émission.', poster_path: '/p.jpg', backdrop_path: '/b.jpg',
      status: 'Returning Series', networks: [{ name: tvd[1] === '1002' ? 'Prime Video' : 'TF1' }], genres, credits, next_episode_to_air: next, last_episode_to_air: last,
      seasons: [{ season_number: 1, air_date: '2026-01-01', episode_count: 10 }] });
  }
  if (p.includes('/lt/series/')) return json({ error: 'not_found' }, 404);
  if (p.includes('/lt/tmdb/')) return json({ results: [] });
  return json({ error: 'not_found' }, 404);
}

async function settle(ms = 60): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, ms / 20));
}

it('ce soir : ignore les chaînes d’information et les créneaux sans données', () => {
  const at = (h: number, m: number) => new Date(2026, 9, 20, h, m).getTime() / 1000;
  const news: GuideChannel = { epgId: 'N', playId: 'N', name: 'BFM TV', logo: '', num: 15 };
  const gen: GuideChannel = { epgId: 'G', playId: 'G', name: 'NRJ 12', logo: '', num: 12 };
  const by = new Map([['N', news], ['G', gen]]);
  const progs: EpgProgram[] = [
    { channelId: 'N', start: at(21, 0), stop: at(23, 0), title: 'Grand Soir' },
    { channelId: 'G', start: at(21, 0), stop: at(23, 0), title: 'No Data' },
  ];
  expect(primeTime(progs, (p) => by.get(p.channelId), '2026-10-20')).toEqual([]);
});

describe('émissions TV (interface)', () => {
  beforeAll(async () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
    document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
    localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: 'http://localhost:7000', config: 'CFG_sh-1' }));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => mockFetch(String(url))));
    window.scrollTo = () => undefined;
    Element.prototype.scrollIntoView = () => undefined;
    await import('../src/main.js');
    await settle(1800);
  });

  it('accueil : entrée de menu, « Ce soir à la TV » et « Émissions du moment »', () => {
    const app = document.getElementById('app')!;
    expect(app.querySelector('.nav [data-showsnav]')).not.toBeNull();
    const rowCards = Array.from(app.querySelectorAll('#emissions .show-card'));
    const byId = (id: string) => rowCards.find((c) => c.getAttribute('data-showopen') === id)!;
    expect(byId('1001').querySelector('.card-meta')!.textContent).toBe('En direct · TF1');
    expect(byId('1001').querySelector('.show-live')).not.toBeNull();
    expect(byId('1002').querySelector('.card-meta')!.textContent).toMatch(/^Prime Video · épisode le /);
    const tonight = Array.from(app.querySelectorAll('#ce-soir .show-card'));
    expect(tonight.length).toBeGreaterThanOrEqual(3);
    // Top Chef (M6) retrouvé sur TMDB : fond paysage (backdrop) et lien vers l'émission ; les autres restent liés à la chaîne.
    const topChef = tonight.find((c) => c.getAttribute('data-showopen') === '1003')!;
    expect(topChef).toBeTruthy();
    expect(topChef.querySelector('img')!.getAttribute('src')).toContain('/tcb.jpg');
    expect(tonight.find((c) => c.getAttribute('data-showwatch') === 'fr:TF1.fr')).toBeTruthy();
    const nums = Array.from(app.querySelectorAll('#ce-soir .ch-num')).map((n) => Number(n.textContent));
    expect(nums.slice(0, 3)).toEqual([1, 2, 3]); // ordre officiel des chaînes
    expect(nums).toContain(6);
    const rate = calls.filter((c) => c.includes('/lt/tmdb/search/tv')).length;
    expect(rate).toBeLessThanOrEqual(2); // seules les émissions présentes au guide sont cherchées
  });

  it('page Émissions TV : à la télé / autres émissions', async () => {
    location.hash = '#/emissions';
    await settle(500);
    const page = document.querySelector('#detail .shows-page')!;
    expect(page).not.toBeNull();
    const ids = Array.from(page.querySelectorAll('.show-card')).map((c) => c.getAttribute('data-showopen'));
    expect(ids).toEqual(expect.arrayContaining(['1001', '1002', '1003']));
    const grids = page.querySelectorAll('.lib-grid');
    expect(Array.from(grids[0].querySelectorAll('.show-card')).map((c) => c.getAttribute('data-showopen'))).toEqual(expect.arrayContaining(['1001', '1003']));
    expect(grids[1].querySelector('[data-showopen="1002"]')).not.toBeNull();
    // Héros : une des émissions connues avec fond (selon l'heure, la soirée ou la plus populaire) ; son titre reçoit le focus.
    const hero = page.querySelector('.sv-hero')!;
    expect(hero.querySelector('.sv-kicker')).not.toBeNull();
    expect(['La France a un incroyable talent', 'Top Chef']).toContain(hero.querySelector('#svc-title')!.textContent);
    expect(hero.querySelector('[data-showopen]')).not.toBeNull();
    expect(page.querySelector('.sv-top [data-showopen="1001"]')).not.toBeNull(); // Top 10 : sections 3 à 5 présentes
    (page.querySelector('[data-showopen="1001"]') as HTMLElement).click();
    await settle(100);
    expect(location.hash).toBe('#/emission/1001');
  });


  it('fiche d’une émission : prochaines diffusions, direct, épisodes précédents, suivre, lecture', async () => {
    await settle(700);
    const d = document.querySelector('#detail .show-fiche')!;
    expect(d).not.toBeNull();
    expect(d.querySelector('#f-title')!.textContent).toBe('La France a un incroyable talent');
    expect(d.querySelector('.sf-kicker')!.textContent).toBe('Émission TV · Téléréalité');
    const meta = d.querySelector('.sf-hero .sf-meta')!.textContent!;
    expect(meta).toContain('TF1');
    expect(meta).toContain('En cours');
    expect(meta).toContain('Présenté par Animateur Test');
    const air = d.querySelector('.sf-airs-list .sf-air.is-live')!;
    expect(air.textContent).toContain('TF1');
    expect(air.textContent).toContain('En direct');
    expect(air.querySelector('.progress')).not.toBeNull();
    expect(d.querySelector('.sf-past .sf-ep')!.textContent).toContain('Auditions 2'); // le plus récent d'abord
    expect(d.querySelector('#show-past')!.textContent).not.toContain('Futur');
    expect(d.querySelector('[data-follow="tv:1001"]')).not.toBeNull();
    // Bouton principal de la fiche en direct : « Regarder en direct » (data-showwatch), pas de « Revoir ».
    const main = d.querySelector('.sf-hero [data-showwatch]') as HTMLElement;
    expect(main.textContent).toContain('Regarder en direct');
    expect(main.dataset.showwatch).toBe('fr:TF1.fr');
    expect(d.querySelector('.sf-hero [data-showep]')).toBeNull();
    (air.querySelector('[data-showwatch]') as HTMLElement).click();
    await settle(400);
    const player = document.getElementById('player') as HTMLElement;
    expect(player.hidden).toBe(false);
    expect(hlsLoads).toContain('http://localhost:7000/CFG_sh-1/lt/tv/hls?u=' + encodeURIComponent('https://up.example/fr:TF1.fr.m3u8') + '&s=SIG_frTF1fr');
    (player.querySelector('[data-pclose]') as HTMLElement).click();
    expect(player.hidden).toBe(true);
  });

  it('fiche d’une émission de streaming : plateforme et nouvel épisode', async () => {
    location.hash = '#/emission/1002';
    await settle(700);
    const d = document.querySelector('#detail .show-fiche')!;
    const next = d.querySelector('#show-next') as HTMLElement;
    expect(next.hidden).toBe(false);
    expect(next.textContent).toContain('Nouvel épisode');
    expect(next.textContent).toContain('Streaming sur Prime Video');
    expect(d.querySelector('#show-where')!.textContent).toContain('Disponible sur');
    expect(d.querySelector('.sf-air')).toBeNull();
    expect(d.querySelector('.sf-airs .row-msg')!.textContent).toContain('Aucune diffusion annoncée');
    // Pas de direct : le bouton principal reprend le dernier épisode diffusé (sources de cet épisode).
    expect(d.querySelector('.sf-hero [data-showwatch]')).toBeNull();
    expect(d.querySelector('.sf-hero [data-showep="1:2"]')!.textContent).toContain('Revoir le dernier épisode');
    expect(d.querySelector('.sf-hero [data-follow="tv:1002"]')).not.toBeNull();
  });

  it('épisode passé : la vignette et « Revoir » lancent playBest pour cet épisode', async () => {
    const d = document.querySelector('#detail .show-fiche')!;
    const card = d.querySelector('#show-past [data-showep="1:2"]') as HTMLElement;
    expect(card.tagName).toBe('BUTTON');
    expect(card.textContent).toContain('S1 · É2');
    expect(card.textContent).toContain('52 min'); // durée du 2e épisode
    expect(card.querySelector('img')!.getAttribute('src')).toContain('/s2.jpg');
    card.click();
    await settle(20);
    expect(playBest).toHaveBeenCalledTimes(1);
    const [req, opener] = vi.mocked(playBest).mock.calls[0];
    expect(req).toMatchObject({ type: 'tv', id: '1002', season: 1, episode: 2, key: 'tv:1002', name: 'LOL : qui rit, sort !' });
    expect(opener).toBe(card);
    expect(location.hash).toBe('#/emission/1002'); // la fiche reste ouverte
    // Un survol réécrit state.ficheName : le nom transmis doit venir de la fiche (data-name), pas de ce champ global.
    Object.assign(state, { ficheName: 'Nom écrasé par un survol' });
    (d.querySelector('.sf-hero [data-showep="1:2"]') as HTMLElement).click();
    await settle(20);
    expect(playBest).toHaveBeenCalledTimes(2);
    expect(vi.mocked(playBest).mock.calls[1][0]).toMatchObject({ type: 'tv', id: '1002', season: 1, episode: 2, name: 'LOL : qui rit, sort !' });
  });

  it('présentation : avatars (photo ou initiales) et présentateur de la fiche', async () => {
    location.hash = '#/emission/1002';
    await settle(700);
    expect(document.querySelector('#detail .show-fiche #sf-h-cast')).toBeNull(); // aucun casting pour cette émission
    location.hash = '#/emission/1001';
    await settle(700);
    const page = document.querySelector('#detail .show-fiche')!;
    const people = Array.from(page.querySelectorAll('.sf-cast .sf-person'));
    expect(page.querySelector('#sf-h-cast')!.textContent).toBe('Présentation');
    expect(people.map((p) => p.querySelector('.sf-pn')!.textContent)).toEqual(['Animateur Test', 'Chroniqueuse Test']);
    expect(people[0].querySelector('.sf-pr')!.textContent).toBe('Himself - Host');
    expect(people[0].querySelector('.sf-av img')!.getAttribute('src')).toContain('/a.jpg');
    expect(people[1].querySelector('.sf-av')!.textContent).toBe('CT');
    expect(page.querySelector('.sf-hero .sf-meta')!.textContent).toContain('Présenté par Animateur Test');
  });

  it('carte « Prochaine diffusion » : heure de fin et chaîne en direct, barre de progression', () => {
    const d = document.querySelector('#detail .show-fiche')!;
    const card = d.querySelector('#show-next') as HTMLElement;
    expect(card.hidden).toBe(false);
    expect(card.textContent).toContain('Prochaine diffusion');
    expect(card.textContent).toContain('TF1 · canal');
    expect(card.textContent).toContain('En direct jusqu’à ' + hhmm(now + 2400));
    expect(card.querySelector('.sf-bar > span')).not.toBeNull();
    expect(card.textContent).not.toContain('Streaming sur'); // TMDB ne donne aucun fournisseur pour cette émission
  });

  it('calendrier : diffusions TV des émissions suivies avec puce « TV »', async () => {
    localStorage.setItem('laststream.follows', JSON.stringify([{ type: 'tv', id: 1001, title: 'La France a un incroyable talent', poster: '/lf.jpg', addedAt: 1 }]));
    location.hash = '#/';
    await settle(100);
    location.hash = '#/calendar';
    await settle(700);
    const chip = document.querySelector('#detail [data-calkind="airing"]') as HTMLElement;
    expect(chip.textContent).toBe('TV');
    const ev = document.querySelector('#detail .cal-ev.kind-airing') as HTMLElement;
    expect(ev).not.toBeNull();
    expect(ev.title).toMatch(/^\d{2}:\d{2} · TF1 · La France a un incroyable talent$/);
    expect(ev.getAttribute('data-showopen')).toBe('1001');
    chip.click();
    await settle(100);
    expect(document.querySelector('#detail .cal-ev.kind-airing')).toBeNull();
  });

  it('page Émissions TV : onglets de genre filtrent les sections, sans appel réseau', async () => {
    location.hash = '#/emissions';
    await settle(500);
    const tabs = Array.from(document.querySelectorAll<HTMLElement>('#detail .sv-tab'));
    expect(tabs.map((t) => t.textContent)).toEqual(['Tout', 'Téléréalité', 'Divertissement']);
    expect(tabs[0].getAttribute('aria-pressed')).toBe('true');
    const zoneIds = () => Array.from(document.querySelectorAll('#detail #sv-zone [data-showopen]')).map((c) => c.getAttribute('data-showopen'));
    expect(zoneIds()).toEqual(expect.arrayContaining(['1001', '1002', '1003']));
    const before = calls.length;
    tabs[1].click(); // Téléréalité : LOL (divertissement) disparaît des sections, les deux autres restent
    await settle(50);
    expect(tabs[1].getAttribute('aria-pressed')).toBe('true');
    expect(tabs[0].getAttribute('aria-pressed')).toBe('false');
    expect(zoneIds()).toEqual(expect.arrayContaining(['1001', '1003']));
    expect(zoneIds()).not.toContain('1002');
    expect(calls.length).toBe(before);
    tabs[2].click(); // Divertissement : seulement LOL
    await settle(50);
    expect(zoneIds().length).toBeGreaterThan(0);
    expect(zoneIds().every((id) => id === '1002')).toBe(true);
    tabs[0].click();
    await settle(50);
    expect(zoneIds()).toEqual(expect.arrayContaining(['1001', '1002', '1003']));
    expect(document.querySelector('#detail .sv-hero #svc-title')).not.toBeNull(); // le héros ne change pas avec le filtre
  });
});
