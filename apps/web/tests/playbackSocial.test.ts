// Social v3 dans le lecteur (lot F5) : mode cinéma, file de bulles, carte de chaleur, anti-spoiler, « regarde aussi »,
// menu et résumé de fin (DOM sans injection).
import { describe, expect, it, vi } from 'vitest';
import { initialCinemaState, initialSocialState, type CinemaState } from '../src/data/socialStore';
import {
  CINEMA_MENU_DEFAULT, HOUR_MS, STACK_MAX, advanceBubble, bucketAt, durationOf, emptyQueue, filmEnded, friendsWatching, heatBars,
  hiddenElements, indicatorText, initialOf, isFuture, isInRoom, roomNames, menuSelection, pushBubble, remainingLabel, startPolicy, toggleElement, untilFor,
} from '../src/player/playbackSocial';
import { createCinemaMenu, createCinemaSummary } from '../src/player/cinemaView';
import { fadeFutureMarkers, renderNoteMarkers } from '../src/player/notesView';
import type { Message, Note } from '../src/data/socialV2Api';

const m = (id: string): Message => ({ id, from: 'a', to: 'me', body: id, createdAt: 1, conv: 'dm:a', kind: 'text', reactions: [] });
const cinema = (over: Partial<CinemaState> = {}): CinemaState => ({ ...initialCinemaState(), active: true, until: 'film', since: 1, ...over });

describe('mode cinéma', () => {
  it('réglage de départ selon prefs.playbackSocial', () => {
    expect(startPolicy('all')).toEqual({ cinema: false, quiet: [] });
    expect(startPolicy('cinema').cinema).toBe(true);
    expect(startPolicy('messages')).toEqual({ cinema: false, quiet: ['notes', 'markers', 'friendsPresence'] });
    expect(startPolicy(undefined).cinema).toBe(false);
  });

  it('éléments masqués : seulement quand le mode est actif et non échu, plus le réglage « messages »', () => {
    expect([...hiddenElements(initialCinemaState(), 0)]).toEqual([]);
    expect(hiddenElements(cinema({ hidden: ['bubbles', 'notes'] }), 5).has('bubbles')).toBe(true);
    expect(hiddenElements(cinema({ hidden: ['bubbles'], until: 100 }), 100).size).toBe(0);
    expect(hiddenElements(initialCinemaState(), 0, ['markers']).has('markers')).toBe(true);
  });

  it('durées et échéances', () => {
    expect(untilFor('film', 5)).toBe('film');
    expect(untilFor('always', 5)).toBe('always');
    expect(untilFor('hour', 1000)).toBe(1000 + HOUR_MS);
    expect(durationOf('film')).toBe('film');
    expect(durationOf(123)).toBe('hour');
    expect(durationOf('always')).toBe('always');
    expect(durationOf(null)).toBe('film');
  });

  it('fin du film : lecture terminée ou à moins d’une seconde de la fin, seulement pour l’échéance « film »', () => {
    expect(filmEnded('film', { time: 7199.5, duration: 7200 })).toBe(true);
    expect(filmEnded('film', { time: 100, duration: 7200 })).toBe(false);
    expect(filmEnded('film', { time: 100, duration: 7200, ended: true })).toBe(true);
    expect(filmEnded('always', { time: 7200, duration: 7200 })).toBe(false);
    expect(filmEnded(99, { time: 7200, duration: 7200 })).toBe(false);
    expect(filmEnded('film', { time: 5, duration: NaN })).toBe(false);
  });

  it('cases : maquette proposée si le réglage n’a jamais été touché, bascule sans doublon', () => {
    expect(menuSelection(['bubbles', 'notes', 'markers']).sort()).toEqual([...CINEMA_MENU_DEFAULT].sort());
    expect(menuSelection(['myPresence'])).toEqual(['myPresence']);
    expect(toggleElement(['notes'], 'markers')).toEqual(['notes', 'markers']);
    expect(toggleElement(['notes', 'markers'], 'notes')).toEqual(['markers']);
  });

  it('textes : temps restant et indicateur', () => {
    expect(remainingLabel(93 * 60)).toBe('1 h 33 restantes');
    expect(remainingLabel(12 * 60)).toBe('12 min restantes');
    expect(remainingLabel(0)).toBe('');
    expect(indicatorText(0)).toBe('Mode cinéma');
    expect(indicatorText(1)).toBe('Mode cinéma · 1 message en attente');
    expect(indicatorText(3)).toBe('Mode cinéma · 3 messages en attente');
  });
});

describe('file de bulles', () => {
  it('le premier message prend la place, les suivants s’empilent sans doublon et bornés', () => {
    let q = pushBubble(emptyQueue(), m('1'), false);
    expect(q.current?.id).toBe('1');
    q = pushBubble(q, m('1'), false);
    expect(q.next).toHaveLength(0);
    for (const id of ['2', '3', '4', '5', '6']) q = pushBubble(q, m(id), false);
    expect(q.next).toHaveLength(STACK_MAX);
    expect(q.next.map((x) => x.id)).toEqual(['4', '5', '6']);
  });

  it('une réponse en cours verrouille la place ; la fermeture promeut le plus ancien en attente', () => {
    const q0 = pushBubble(emptyQueue(), m('1'), false);
    const q1 = pushBubble(q0, m('2'), true);
    expect(q1.current?.id).toBe('1');
    expect(q1.next.map((x) => x.id)).toEqual(['2']);
    const q2 = advanceBubble(q1);
    expect(q2.current?.id).toBe('2');
    expect(advanceBubble(q2).current).toBeNull();
    expect(pushBubble(emptyQueue(), m('x'), true).current).toBeNull();
  });
});

describe('carte de chaleur et anti-spoiler', () => {
  it('barres normalisées au maximum, teinte par niveau, rien si tout est nul', () => {
    const bars = heatBars([0, 2, 5, 10, NaN, -3]);
    expect(bars).toHaveLength(6);
    expect(bars[3]).toEqual({ h: 1, level: 3 });
    expect(bars[2].level).toBe(2);
    expect(bars[1].level).toBe(0);
    expect(bars[4].h).toBe(0);
    expect(heatBars([0, 0, 0])).toEqual([]);
    expect(heatBars([])).toEqual([]);
  });

  it('tranche de la position courante, bornée', () => {
    expect(bucketAt(0, 100, 60)).toBe(0);
    expect(bucketAt(50, 100, 60)).toBe(30);
    expect(bucketAt(100, 100, 60)).toBe(59);
    expect(bucketAt(5, 0, 60)).toBe(-1);
  });

  it('une note est « à venir » seulement au-delà de la position et avec l’anti-spoiler', () => {
    expect(isFuture(500, 100, true)).toBe(true);
    expect(isFuture(500, 100, false)).toBe(false);
    expect(isFuture(50, 100, true)).toBe(false);
    expect(isFuture(100.5, 100, true)).toBe(false);
  });

  it('les marqueurs à venir sont estompés et ne révèlent plus leur contenu', () => {
    const note = (id: string, pos: number): Note => ({
      id, pos, kind: 'text', body: 'secret', createdAt: 1,
      author: { pid: 'a', handle: { name: 'Amy', tag: 'B2C3', full: 'Amy#B2C3' }, avatarColor: '#aa0000' },
    });
    const box = document.createElement('div');
    renderNoteMarkers(box, [{ pct: 10, notes: [note('a', 100)] }, { pct: 80, notes: [note('b', 800)] }], () => undefined);
    fadeFutureMarkers(box, 200, true);
    const [first, second] = Array.from(box.children) as HTMLElement[];
    expect(first.classList.contains('is-future')).toBe(false);
    expect(first.getAttribute('aria-label')).toContain('secret');
    expect(second.classList.contains('is-future')).toBe(true);
    expect(second.getAttribute('aria-label')).not.toContain('secret');
    fadeFutureMarkers(box, 200, false);
    expect(second.classList.contains('is-future')).toBe(false);
    expect(second.getAttribute('aria-label')).toContain('secret');
  });
});

describe('« regarde aussi »', () => {
  const NOW = 1_000_000;
  const friend = (pid: string, w: Record<string, unknown> | undefined, over: Record<string, unknown> = {}) => ({
    pid, handle: { name: pid, tag: '0000', full: pid + '#0000' }, avatarColor: '#aa0000', household: false, status: 'online' as const,
    watching: w, ...over,
  });
  const watch = (over: Record<string, unknown> = {}) => ({ type: 'movie', tmdbId: 7, title: 'T', pos: 100, paused: false, at: NOW - 10_000, ...over });
  const s = (friends: unknown[], household: unknown[] = []) => ({ ...initialSocialState(), friends, household }) as never;

  it('position estimée avec le temps écoulé, figée en pause, bornée à la durée', () => {
    const media = { type: 'movie' as const, tmdbId: 7 };
    expect(friendsWatching(s([friend('lea', watch())]), media, NOW)[0].pos).toBeCloseTo(110, 1);
    expect(friendsWatching(s([friend('lea', watch({ paused: true }))]), media, NOW)[0].pos).toBe(100);
    expect(friendsWatching(s([friend('lea', watch({ duration: 105 }))]), media, NOW)[0].pos).toBe(105);
  });

  it('même média seulement (épisode compris), relevé récent, avec position', () => {
    const media = { type: 'series' as const, tmdbId: 7, season: 1, episode: 2 };
    const ok = watch({ type: 'series', season: 1, episode: 2 });
    expect(friendsWatching(s([friend('a', ok)]), media, NOW)).toHaveLength(1);
    expect(friendsWatching(s([friend('a', watch({ type: 'series', season: 1, episode: 3 }))]), media, NOW)).toHaveLength(0);
    expect(friendsWatching(s([friend('a', watch({ tmdbId: 8 }))]), { type: 'movie', tmdbId: 7 }, NOW)).toHaveLength(0);
    expect(friendsWatching(s([friend('a', watch({ at: NOW - 200_000 }))]), { type: 'movie', tmdbId: 7 }, NOW)).toHaveLength(0);
    expect(friendsWatching(s([friend('a', watch({ pos: undefined }))]), { type: 'movie', tmdbId: 7 }, NOW)).toHaveLength(0);
    expect(friendsWatching(s([friend('a', undefined)]), { type: 'movie', tmdbId: 7 }, NOW)).toHaveLength(0);
    expect(friendsWatching(s([]), null, NOW)).toEqual([]);
  });

  it('un ami présent dans les amis et le foyer n’apparaît qu’une fois ; le surnom prime', () => {
    const a = friend('a', watch(), { nickname: 'Lélé' });
    const out = friendsWatching(s([a], [a]), { type: 'movie', tmdbId: 7 }, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Lélé');
  });

  it('en salon : les amis déjà dans le salon ne sont pas proposés (nom, « compte · profil », nom complet ou surnom)', () => {
    const media = { type: 'movie' as const, tmdbId: 7 };
    const olivier = friend('p-olivier', watch(), { handle: { name: 'Olivier', tag: '1234', full: 'Olivier#1234' } });
    const lea = friend('p-lea', watch({ pos: 50 }));
    const all = s([olivier, lea]);
    // Hors salon (null) : inchangé.
    expect(friendsWatching(all, media, NOW).map((p) => p.pid)).toEqual(['p-olivier', 'p-lea']);
    expect(friendsWatching(all, media, NOW, 0, null).map((p) => p.pid)).toEqual(['p-olivier', 'p-lea']);
    // Salon vide ou sans cet ami : inchangé.
    expect(friendsWatching(all, media, NOW, 0, []).map((p) => p.pid)).toEqual(['p-olivier', 'p-lea']);
    expect(friendsWatching(all, media, NOW, 0, [{ username: 'Hugo' }]).map((p) => p.pid)).toEqual(['p-olivier', 'p-lea']);
    // Pseudo du salon = nom de l'ami (sans tenir compte de la casse), ou « compte · profil », ou nom complet.
    expect(friendsWatching(all, media, NOW, 0, [{ username: 'olivier' }]).map((p) => p.pid)).toEqual(['p-lea']);
    expect(friendsWatching(all, media, NOW, 0, [{ username: 'greg · Olivier' }]).map((p) => p.pid)).toEqual(['p-lea']);
    expect(friendsWatching(all, media, NOW, 0, [{ username: 'Olivier#1234' }]).map((p) => p.pid)).toEqual(['p-lea']);
    const nick = friend('p-nick', watch(), { nickname: 'Lélé' });
    expect(friendsWatching(s([nick]), media, NOW, 0, [{ username: 'lélé' }])).toHaveLength(0);
    // Le foyer est filtré de la même façon.
    expect(friendsWatching(s([], [olivier]), media, NOW, 0, [{ username: 'Olivier' }])).toHaveLength(0);
    // Tout le monde est dans le salon : plus de puce.
    expect(friendsWatching(all, media, NOW, 0, [{ username: 'Olivier' }, { username: 'p-lea' }])).toEqual([]);
  });

  it('correspondance de salon : noms reconnus et participants vides', () => {
    expect(roomNames('Greg · Olivier')).toEqual(['greg · olivier', 'olivier']);
    expect(roomNames('  Léa ')).toEqual(['léa']);
    expect(roomNames(undefined)).toEqual(['']);
    const f = { handle: { name: 'Olivier', full: 'Olivier#1234' }, nickname: null };
    expect(isInRoom(f, null)).toBe(false);
    expect(isInRoom(f, [])).toBe(false);
    expect(isInRoom(f, [{ username: '' }])).toBe(false);
    expect(isInRoom(f, [{ username: 'Olivier' }])).toBe(true);
  });

  it('initiale de repli', () => {
    expect(initialOf('léa')).toBe('L');
    expect(initialOf('')).toBe('?');
  });
});

describe('menu du mode cinéma', () => {
  const model = (over = {}) => ({ active: false, duration: 'film' as const, hidden: ['bubbles', 'notes'] as never, remaining: '1 h 33 restantes', ...over });
  const handlers = () => ({ onSwitch: vi.fn(), onDuration: vi.fn(), onToggle: vi.fn(), onClose: vi.fn() });

  it('affiche l’état, appelle les rappels, Échap ferme sans toucher aux raccourcis du lecteur', () => {
    const h = handlers();
    const menu = createCinemaMenu(h);
    document.body.append(menu.el);
    expect(menu.isOpen()).toBe(false);
    menu.open(model());
    expect(menu.isOpen()).toBe(true);
    const sw = menu.el.querySelector('[role="switch"]') as HTMLElement;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(menu.el.querySelectorAll('[role="radio"]')).toHaveLength(3);
    expect(menu.el.querySelectorAll('[role="checkbox"]')).toHaveLength(6);
    expect(menu.el.querySelector('.lp-cm-rem')?.textContent).toBe('1 h 33 restantes');
    const boxes = Array.from(menu.el.querySelectorAll('[role="checkbox"]'));
    expect(boxes.filter((b) => b.getAttribute('aria-checked') === 'true')).toHaveLength(2);
    sw.click();
    expect(h.onSwitch).toHaveBeenCalledWith(true);
    (menu.el.querySelectorAll('[role="radio"]')[1] as HTMLElement).click();
    expect(h.onDuration).toHaveBeenCalledWith('hour');
    (boxes[3] as HTMLElement).click();
    expect(h.onToggle).toHaveBeenCalledWith('friendsPresence');
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    menu.el.dispatchEvent(ev);
    expect(h.onClose).toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
    menu.el.remove();
  });

  it('mode actif : l’interrupteur propose d’arrêter, la durée est figée', () => {
    const h = handlers();
    const menu = createCinemaMenu(h);
    menu.open(model({ active: true, duration: 'hour' }));
    const sw = menu.el.querySelector('[role="switch"]') as HTMLElement;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    sw.click();
    expect(h.onSwitch).toHaveBeenCalledWith(false);
    const radios = Array.from(menu.el.querySelectorAll('[role="radio"]')) as HTMLButtonElement[];
    expect(radios.map((r) => r.disabled)).toEqual([true, false, true]);
  });
});

describe('indicateur du mode cinéma', () => {
  it('« Mode cinéma · N messages en attente », « Mode cinéma » seul à zéro, singulier à un', () => {
    expect(indicatorText(0)).toBe('Mode cinéma');
    expect(indicatorText(1)).toBe('Mode cinéma · 1 message en attente');
    expect(indicatorText(3)).toBe('Mode cinéma · 3 messages en attente');
  });
});

describe('résumé de fin de mode', () => {
  it('texte en textContent, notes cliquables vers leur position', () => {
    const onSeek = vi.fn();
    const sum = createCinemaSummary(() => undefined, onSeek);
    document.body.append(sum.el);
    sum.show({
      messages: 3, byFriend: [{ pid: 'a', handle: { name: 'Léa', tag: '1', full: 'Léa#1' }, count: 3 }],
      notes: [{
        id: 'n', pos: 90, kind: 'text', body: '<img src=x onerror=alert(1)>', createdAt: 1,
        author: { pid: 'a', handle: { name: 'Léa', tag: '1', full: 'Léa#1' }, avatarColor: '#aa0000' },
      }],
    });
    expect(sum.isOpen()).toBe(true);
    expect(sum.el.querySelector('img')).toBeNull();
    expect(sum.el.textContent).toContain('3 messages reçus');
    expect(sum.el.textContent).toContain('Léa : 3');
    expect(sum.el.textContent).not.toContain('#1');
    (sum.el.querySelector('.lp-cs-note') as HTMLElement).click();
    expect(onSeek).toHaveBeenCalledWith(90);
    sum.show({ messages: 0, byFriend: [], notes: [] });
    expect(sum.el.textContent).toContain('Rien de nouveau');
    sum.hide();
    expect(sum.isOpen()).toBe(false);
    sum.el.remove();
  });
});
