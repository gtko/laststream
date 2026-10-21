// Page Calendrier (ODY-212) : logique pure (types, statuts, sélection, clavier) et rendu du mois, du panneau du jour et de l'agenda.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CAL_KINDS, cellPreview, countByKind, dayAriaLabel, dayTitle, dotKinds, eventStatus, eventSubtitle, filterByKinds, hueOf, initials, kindOfEvent, moveSelection, pickSelectedDate,
  type CalEvent,
} from '../src/data/calendar';

const ev = (kind: CalEvent['kind'], over: Partial<CalEvent> = {}): CalEvent => ({ date: '2026-10-21', kind, key: 'tv:1', title: 'Titre', poster: '', label: 'S1 É1', ...over });

describe('logique pure du calendrier', () => {
  it('kindOfEvent : épisode = série, les autres gardent leur type', () => {
    expect(['episode', 'movie', 'airing', 'person'].map((kind) => kindOfEvent({ kind } as CalEvent))).toEqual(['tv', 'movie', 'airing', 'person']);
    expect(CAL_KINDS.map((k) => k.label)).toEqual(['Films', 'Séries', 'TV', 'Personnes']);
  });

  it('countByKind compte avant filtrage ; filterByKinds applique les types cochés', () => {
    const evs = [ev('episode'), ev('episode'), ev('movie'), ev('airing'), ev('person')];
    expect(countByKind(evs)).toEqual({ movie: 1, tv: 2, airing: 1, person: 1 });
    expect(filterByKinds(evs, new Set(['tv', 'person'])).map((e) => e.kind)).toEqual(['episode', 'episode', 'person']);
  });

  it('pickSelectedDate : aujourd’hui dans le mois, sinon 1er jour avec une sortie, sinon le 1er', () => {
    const evs = [ev('movie', { date: '2026-11-18' }), ev('movie', { date: '2026-11-09' }), ev('movie', { date: '2026-12-02' })];
    expect(pickSelectedDate(2026, 10, evs, '2026-10-21')).toBe('2026-10-21');
    expect(pickSelectedDate(2026, 11, evs, '2026-10-21')).toBe('2026-11-09');
    expect(pickSelectedDate(2027, 1, evs, '2026-10-21')).toBe('2027-01-01');
  });

  it('moveSelection : flèches ±1 / ±7, Home / End = semaine, jamais hors du mois', () => {
    expect(moveSelection('2026-10-21', 'ArrowRight', 2026, 10)).toBe('2026-10-22');
    expect(moveSelection('2026-10-21', 'ArrowLeft', 2026, 10)).toBe('2026-10-20');
    expect(moveSelection('2026-10-21', 'ArrowDown', 2026, 10)).toBe('2026-10-28');
    expect(moveSelection('2026-10-21', 'ArrowUp', 2026, 10)).toBe('2026-10-14');
    expect(moveSelection('2026-10-28', 'ArrowDown', 2026, 10)).toBe('2026-10-28'); // 4 novembre : hors mois
    expect(moveSelection('2026-10-01', 'ArrowLeft', 2026, 10)).toBe('2026-10-01');
    expect(moveSelection('2026-10-21', 'Home', 2026, 10)).toBe('2026-10-19'); // lundi
    expect(moveSelection('2026-10-21', 'End', 2026, 10)).toBe('2026-10-25'); // dimanche
    expect(moveSelection('2026-10-30', 'End', 2026, 10)).toBe('2026-10-31'); // fin de semaine hors mois : borné
    expect(moveSelection('2026-10-02', 'Home', 2026, 10)).toBe('2026-10-01');
    expect(moveSelection('2026-10-21', 'a', 2026, 10)).toBe('2026-10-21');
  });

  it('cellPreview : jusqu’à 3 affiches, au-delà 2 affiches et « +N » (N = total - 2)', () => {
    expect(cellPreview([1, 2, 3])).toEqual({ shown: [1, 2, 3], more: 0 });
    expect(cellPreview([1, 2, 3, 4])).toEqual({ shown: [1, 2], more: 2 });
    expect(cellPreview([1, 2, 3, 4, 5, 6])).toEqual({ shown: [1, 2], more: 4 });
    expect(cellPreview([])).toEqual({ shown: [], more: 0 });
  });

  it('dotKinds : un point par type présent, 3 au plus', () => {
    expect(dotKinds([ev('episode'), ev('episode'), ev('movie')])).toEqual({ shown: ['movie', 'tv'], more: false });
    expect(dotKinds([ev('episode'), ev('movie'), ev('airing'), ev('person')])).toEqual({ shown: ['movie', 'tv', 'airing'], more: true });
    expect(dotKinds([])).toEqual({ shown: [], more: false });
  });

  it('libellés : aria d’une cellule, titre du jour, initiales et teinte stables', () => {
    expect(dayAriaLabel('2026-10-21', 4)).toBe('21 octobre, 4 sorties');
    expect(dayAriaLabel('2026-10-01', 1)).toBe('1 octobre, 1 sortie');
    expect(dayAriaLabel('2026-10-02', 0)).toBe('2 octobre, aucune sortie');
    expect(dayTitle('2026-10-21')).toBe('mercredi 21 octobre');
    expect(initials('Le Dernier Phare')).toBe('LD');
    expect(initials('Cendres')).toBe('C');
    expect(initials('')).toBe('');
    expect(hueOf('Horizon 9')).toBe(hueOf('Horizon 9'));
    expect(hueOf('Horizon 9')).toBeGreaterThanOrEqual(0);
    expect(hueOf('Horizon 9')).toBeLessThan(360);
  });

  it('eventStatus : passé, aujourd’hui, futur', () => {
    const future = (iso: string) => (iso === '2026-10-22' ? 'Demain' : 'Dans 5 jours');
    const st = (kind: CalEvent['kind'], date: string, label = 'S1 É1') => eventStatus({ kind, date, label }, '2026-10-21', future);
    expect(st('episode', '2026-10-20')).toEqual({ text: 'Sorti', hot: false });
    expect(st('movie', '2026-10-01')).toEqual({ text: 'Sorti', hot: false });
    expect(st('episode', '2026-10-21')).toEqual({ text: 'Ce soir', hot: true });
    expect(st('movie', '2026-10-21', 'Au cinéma')).toEqual({ text: 'Aujourd’hui', hot: false });
    expect(st('airing', '2026-10-21', '20:55 · TF1')).toEqual({ text: 'Ce soir · 20:55', hot: true });
    expect(st('airing', '2026-10-20', '20:55 · TF1')).toEqual({ text: 'Diffusé', hot: false });
    expect(st('episode', '2026-10-22')).toEqual({ text: 'Demain', hot: false });
    expect(st('movie', '2026-10-26', 'Au cinéma')).toEqual({ text: 'Dans 5 jours', hot: false });
    expect(st('airing', '2026-10-22', '20:55 · TF1')).toEqual({ text: 'Demain · 20:55', hot: false });
  });

  it('eventSubtitle : titre d’épisode seulement s’il est utile, chaîne pour une diffusion', () => {
    expect(eventSubtitle(ev('episode', { epTitle: 'Retour à la base' }), true)).toBe('S1 É1 · Retour à la base');
    expect(eventSubtitle(ev('episode', { epTitle: 'Épisode 4' }), false)).toBe('S1 É1');
    expect(eventSubtitle(ev('episode', { epTitle: 'Saison', count: 3, label: 'S3 É1–É3' }), true)).toBe('S3 É1–É3');
    expect(eventSubtitle(ev('airing', { label: '20:55 · TF1' }), true)).toBe('TF1');
    expect(eventSubtitle(ev('movie', { label: 'Au cinéma' }), true)).toBe('Au cinéma');
  });
});

// ---------- Rendu de la page ----------
const BASE = 'http://localhost:7000';
const CFG = 'CFG_calview-test';
let fetchCalls = 0;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const $$ = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));

const EVENTS: Array<Partial<CalEvent>> = [
  { date: '2026-10-21', kind: 'episode', key: 'tv:1', title: 'Horizon 9', poster: '/h.jpg', label: 'S1 É50', season: 1, episode: 50, epTitle: 'Retour à la base' },
  { date: '2026-10-21', kind: 'episode', key: 'tv:3', title: 'Maison Rouge', poster: '', label: 'S2 É8', season: 2, episode: 8, epTitle: 'Épisode 8' },
  { date: '2026-10-21', kind: 'movie', key: 'movie:2', title: 'Le Dernier Phare', poster: '/p.jpg', label: 'En streaming' },
  { date: '2026-10-21', kind: 'person', key: 'movie:9', title: 'Sous la glace', poster: '/s.jpg', label: 'Avec L. Marchand' },
  { date: '2026-10-22', kind: 'episode', key: 'tv:1', title: 'Horizon 9', poster: '/h.jpg', label: 'S1 É51', season: 1, episode: 51, epTitle: 'Le dernier signal' },
  { date: '2026-10-19', kind: 'movie', key: 'movie:4', title: 'Nord-Nord-Est', poster: '/n.jpg', label: 'Au cinéma' },
];

describe('page Calendrier : rendu et interactions', () => {
  let cal: typeof import('../src/ui/calendar.js');

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 21, 12, 0, 0));
    const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
    document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
    $('#detail').hidden = false; // jsdom ne donne pas le focus à un élément d'un conteneur masqué
    localStorage.setItem('laststream.lastaddon', JSON.stringify({ base: BASE, config: CFG }));
    localStorage.setItem('laststream.follows', JSON.stringify([{ type: 'tv', id: 1, title: 'Horizon 9', poster: '/h.jpg', addedAt: 1 }]));
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls += 1;
      const u = new URL(String(url));
      if (u.pathname === '/' + CFG + '/lt/calendar/batch') {
        const { from, to } = JSON.parse(String(init?.body)) as { from: string; to: string };
        return json({ events: EVENTS.filter((e) => e.date! >= from && e.date! <= to) });
      }
      return json({ error: 'not_found' }, 404);
    }));
    window.scrollTo = () => undefined;
    Element.prototype.scrollIntoView = () => undefined;
    await import('../src/ui/ctxmenu.js');
    cal = await import('../src/ui/calendar.js');
    cal.showCalendar();
    await settle();
  });

  afterAll(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('en-tête compact : titre focalisé, sous-titre, Aujourd’hui et Mois | Agenda, pas de grand bandeau', () => {
    expect($('#svc-title').textContent).toBe('Calendrier');
    expect(document.activeElement).toBe($('#svc-title'));
    expect($('.cal-sub').textContent).toBe('Les sorties de ce que tu suis');
    expect(document.querySelector('#detail .svc-head')).toBeNull();
    expect($('[data-caltoday]').textContent).toBe('Aujourd’hui');
    expect($$('[data-calmode]').map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['Mois', 'true'], ['Agenda', 'false']]);
    expect($('#cal-title').textContent).toBe('octobre 2026');
    expect($('[data-calstep="-1"]').getAttribute('aria-label')).toBe('Mois précédent');
  });

  it('filtres : 4 pastilles colorées avec le nombre de sorties du mois par type', () => {
    expect($$('[data-calkind]').map((b) => b.textContent)).toEqual(['Films', 'Séries', 'TV', 'Personnes']);
    expect($$('[data-calkind]').map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'true', 'true', 'true']);
    expect($$('[data-calkind] .cal-n').map((n) => n.dataset.n)).toEqual(['2', '3', '0', '1']);
    expect($('[data-calkind="tv"]').getAttribute('aria-label')).toBe('Séries, 3 sorties');
  });

  it('grille : un bouton par jour du mois, aujourd’hui sélectionné, +N au-delà de 3 sorties', () => {
    expect($$('.cal-cell')).toHaveLength(31);
    expect($$('.cal-day.is-out').every((d) => d.tagName === 'DIV')).toBe(true);
    const today = $('[data-caldate="2026-10-21"]');
    expect(today.getAttribute('aria-pressed')).toBe('true');
    expect(today.getAttribute('aria-label')).toBe('21 octobre, 4 sorties');
    expect(today.classList.contains('is-today')).toBe(true);
    expect(today.querySelector('.cal-tag')!.textContent).toBe('Ce soir');
    expect(today.querySelectorAll('.cal-th')).toHaveLength(2);
    expect(today.querySelector('.cal-more')!.textContent).toBe('+2');
    expect(today.querySelector('.cal-cap')!.textContent).toBe('S1 É50 Horizon 9');
    expect($('[data-caldate="2026-10-22"]').querySelector('.cal-tag')).toBeNull();
    expect($('[data-caldate="2026-10-19"]').classList.contains('is-past')).toBe(true);
    expect($('[data-caldate="2026-10-05"]').getAttribute('aria-label')).toBe('5 octobre, aucune sortie');
    expect($('[data-caldate="2026-10-21"]').tabIndex).toBe(0);
    expect($('[data-caldate="2026-10-22"]').tabIndex).toBe(-1);
  });

  it('panneau du jour : une carte par sortie, liens directs, statuts', () => {
    expect($('.cal-panel').getAttribute('aria-label')).toBe('Détail du jour');
    expect($('.cal-panel h2').textContent).toBe('mercredi 21 octobre');
    expect($('.cal-panel .cal-now').textContent).toBe('Aujourd’hui');
    const cards = $$('.cal-panel .cal-ev');
    expect(cards).toHaveLength(4);
    const ep = cards[0];
    expect(ep.querySelector('.cal-evk')!.textContent).toBe('Série');
    expect(ep.querySelector('.cal-evt')!.textContent).toBe('Horizon 9');
    expect(ep.querySelector('.cal-evs')!.textContent).toBe('S1 É50 · Retour à la base');
    expect(ep.querySelector('.cal-st')!.textContent).toBe('Ce soir');
    expect(ep.querySelector('.cal-st')!.classList.contains('hot')).toBe(true);
    const go = ep.querySelector('.cal-go') as HTMLElement;
    expect(go.textContent).toBe('Ouvrir l’épisode');
    expect([go.dataset.open, go.dataset.openSeason, go.dataset.openEpisode]).toEqual(['tv:1', '1', '50']);
    expect(ep.querySelector('img')!.getAttribute('src')).toBe('https://image.tmdb.org/t/p/w185/h.jpg');
    expect(cards[1].querySelector('.cal-go')!.textContent).toBe('Ouvrir la fiche'); // tri par titre : film
    expect(cards[1].querySelector('.cal-st')!.textContent).toBe('Aujourd’hui');
    expect(cards[2].querySelector('.cal-evs')!.textContent).toBe('S2 É8'); // titre générique : pas répété
    expect(cards[2].querySelector('img')).toBeNull();
    expect(cards[2].querySelector('.cal-th b')!.textContent).toBe('MR');
    expect($$('.cal-panel [data-remindkey]')).toHaveLength(0); // pas de cloche pour aujourd’hui
  });

  it('clic sur un jour : panneau mis à jour sans recharger, cloche pour une sortie future', async () => {
    const before = fetchCalls;
    $('[data-caldate="2026-10-22"]').click();
    expect(fetchCalls).toBe(before);
    expect($('[data-caldate="2026-10-22"]').getAttribute('aria-pressed')).toBe('true');
    expect($('[data-caldate="2026-10-21"]').getAttribute('aria-pressed')).toBe('false');
    expect($('.cal-panel h2').textContent).toBe('jeudi 22 octobre');
    expect(document.querySelector('.cal-panel .cal-now')).toBeNull();
    expect($('.cal-panel .cal-st').textContent).toBe('Demain');
    const bell = $('.cal-panel [data-remindkey]');
    expect(bell.dataset.remindkey).toBe('tv:1');
    expect(bell.getAttribute('aria-pressed')).toBe('false');
    expect(bell.getAttribute('aria-label')).toBe('Me rappeler : Horizon 9');
    const panel = $('.cal-panel').innerHTML;
    $('[data-caldate="2026-10-22"]').click(); // déjà sélectionné : rien de plus
    expect($('.cal-panel').innerHTML).toBe(panel);
    $('[data-caldate="2026-10-05"]').click();
    expect($('.cal-panel .cal-empty').textContent).toBe('Rien de prévu ce jour-là…');
    await settle(0);
  });

  it('clavier : flèches et Home / End déplacent la sélection ET le focus', () => {
    const press = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    $('[data-caldate="2026-10-21"]').click();
    $('[data-caldate="2026-10-21"]').focus();
    press('ArrowRight');
    expect(document.activeElement).toBe($('[data-caldate="2026-10-22"]'));
    expect($('.cal-panel h2').textContent).toBe('jeudi 22 octobre');
    press('ArrowDown');
    expect(document.activeElement).toBe($('[data-caldate="2026-10-29"]'));
    press('ArrowDown'); // 5 novembre : hors du mois, on ne bouge pas
    expect(document.activeElement).toBe($('[data-caldate="2026-10-29"]'));
    press('ArrowUp');
    expect(document.activeElement).toBe($('[data-caldate="2026-10-22"]'));
    press('Home');
    expect(document.activeElement).toBe($('[data-caldate="2026-10-19"]'));
    expect($('[data-caldate="2026-10-19"]').tabIndex).toBe(0);
    press('End');
    expect(document.activeElement).toBe($('[data-caldate="2026-10-25"]'));
  });

  it('filtres : décocher un type met à jour la grille ; le dernier type reste coché', () => {
    $('[data-caldate="2026-10-21"]').click();
    $('[data-calkind="tv"]').click();
    expect($('[data-calkind="tv"]').getAttribute('aria-pressed')).toBe('false');
    expect($('[data-caldate="2026-10-21"]').getAttribute('aria-label')).toBe('21 octobre, 2 sorties');
    expect($('[data-calkind="tv"] .cal-n').dataset.n).toBe('3'); // compté avant filtrage
    expect($('[data-caldate="2026-10-21"]').getAttribute('aria-pressed')).toBe('true'); // sélection conservée
    ['movie', 'airing'].forEach((k) => $('[data-calkind="' + k + '"]').click());
    $('[data-calkind="person"]').click(); // dernier type : refusé
    expect($('[data-calkind="person"]').getAttribute('aria-pressed')).toBe('true');
    ['movie', 'tv', 'airing'].forEach((k) => $('[data-calkind="' + k + '"]').click());
    expect($$('[data-calkind]').every((b) => b.getAttribute('aria-pressed') === 'true')).toBe(true);
  });

  it('agenda : groupes par jour, cartes cliquables sans bouton imbriqué, passés atténués', () => {
    $('[data-calmode="agenda"]').click();
    expect($('[data-calmode="agenda"]').getAttribute('aria-pressed')).toBe('true');
    const days = $$('.cal-ag-day');
    expect(days).toHaveLength(3); // 19, 21, 22
    expect(days[0].classList.contains('is-past')).toBe(true);
    expect(days[1].classList.contains('is-today')).toBe(true);
    expect(days[1].querySelector('.cal-dn')!.textContent).toBe('21');
    expect(days[1].querySelector('.cal-dfull')!.textContent).toBe('mercredi 21 octobre');
    expect(days[1].querySelector('.cal-now')!.textContent).toBe('Aujourd’hui');
    expect(days[1].querySelectorAll('.cal-ev')).toHaveLength(4);
    expect(document.querySelectorAll('#cal-body button button')).toHaveLength(0);
    const hit = days[1].querySelector('.cal-hit') as HTMLElement;
    expect([hit.dataset.open, hit.dataset.openSeason, hit.dataset.openEpisode]).toEqual(['tv:1', '1', '50']);
    expect(days[2].querySelector('.cal-bell')!.getAttribute('aria-label')).toBe('Me rappeler : Horizon 9');
    $('[data-calmode="month"]').click();
    expect($$('.cal-cell')).toHaveLength(31);
  });

  it('changement de mois : sélection recalculée et données rechargées', async () => {
    const before = fetchCalls;
    $('[data-calstep="1"]').click();
    expect($('#cal-body').getAttribute('aria-busy')).toBe('true');
    expect($('#cal-body').classList.contains('is-loading')).toBe(true);
    await settle();
    expect(fetchCalls).toBeGreaterThan(before);
    expect($('#cal-title').textContent).toBe('novembre 2026');
    expect($('#cal-body').getAttribute('aria-busy')).toBe('false');
    expect($$('.cal-cell')).toHaveLength(30);
    expect($('.cal-cell.is-sel').dataset.caldate).toBe('2026-11-01'); // aucune sortie ce mois-là
    $('[data-caltoday]').click();
    await settle();
    expect($('#cal-title').textContent).toBe('octobre 2026');
    expect($('.cal-cell.is-sel').dataset.caldate).toBe('2026-10-21');
  });
});
