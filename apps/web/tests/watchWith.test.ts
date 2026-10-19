// « Regarder avec lui » (Social v2, lot 3a) : position estimée (resumePosition), cible de lecture, handler branché sur la
// fiche d’ami. La lecture est un faux : aucun lecteur n’est chargé.
import { describe, expect, it, vi } from 'vitest';
import type { FriendView, Watching } from '../src/data/socialV2Api';
import {
  createWatchWithHandler, LAUNCH_ERROR, NOT_OPENABLE, playAt, playRequestOf, resumePosition,
} from '../src/data/watchWith';

const watching = (over: Partial<Watching> = {}): Watching => ({
  type: 'movie', tmdbId: 1, title: 'Film', pos: 100, paused: false, at: 0, ...over,
});

const friend = (over: Partial<FriendView> = {}): FriendView => ({
  pid: 'p1', handle: { name: 'Greg', tag: 'A7K2', full: 'Greg#A7K2' }, avatarColor: '#3b82f6', household: false,
  status: 'online', ...over,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Lecture factice : accepte les arguments (request, opener, opts) pour que `mock.calls` reste indexable. */
const fakeLaunch = () => vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve());

describe('resumePosition', () => {
  it('en pause : la position du relevé, sans avancer', () => {
    expect(resumePosition(watching({ pos: 100, paused: true, at: 0 }), 60_000)).toBe(100);
  });

  it('non pausé : relevé + temps écoulé depuis `at`', () => {
    const at = 1_000_000;
    expect(resumePosition(watching({ pos: 100, at }), at + 30_000)).toBeCloseTo(130, 5);
  });

  it('bornée à durée − 5 s quand la durée est connue', () => {
    const at = 1_000_000;
    expect(resumePosition(watching({ pos: 190, duration: 200, at }), at + 60_000)).toBe(195);
  });

  it('jamais négative', () => {
    expect(resumePosition(watching({ pos: -20, paused: true }), 0)).toBe(0);
    expect(resumePosition(watching({ pos: -20, at: 0 }), 5_000)).toBe(0);
  });

  it('relevé daté du futur : la position n’avance pas', () => {
    const now = 1_000_000;
    expect(resumePosition(watching({ pos: 100, at: now + 60_000 }), now)).toBe(100);
  });

  it('durée inférieure à 5 s : position 0', () => {
    expect(resumePosition(watching({ pos: 2, duration: 3, paused: true }), 0)).toBe(0);
  });

  it('sans durée : pas de plafond', () => {
    const at = 0;
    expect(resumePosition(watching({ pos: 100, at, duration: undefined }), at + 3_600_000)).toBeCloseTo(3700, 5);
  });

  it('valeurs non numériques : repli sur 0 ou sur la position', () => {
    expect(resumePosition(watching({ pos: Number.NaN, paused: true }), 0)).toBe(0);
    expect(resumePosition(watching({ pos: 100, at: Number.NaN }), 5_000)).toBe(100);
  });
});

describe('playRequestOf', () => {
  it('film : cible movie, sans saison ni épisode', () => {
    expect(playRequestOf({ type: 'movie', tmdbId: 5, title: 'Dune' })).toEqual({
      type: 'movie', id: '5', name: 'Dune', season: null, episode: null, key: 'movie:5',
    });
  });

  it('série : type tv, saison et épisode, clé tv:<id>, imdb si connu', () => {
    expect(playRequestOf({ type: 'series', tmdbId: 7, title: 'Severance', season: 1, episode: 3, imdbId: 'tt123' })).toEqual({
      type: 'tv', id: '7', name: 'Severance', season: 1, episode: 3, key: 'tv:7', imdb: 'tt123',
    });
  });

  it('série sans épisode ou identifiant invalide : pas de cible', () => {
    expect(playRequestOf({ type: 'series', tmdbId: 7, season: 1 })).toBeNull();
    expect(playRequestOf({ type: 'movie', tmdbId: 0 })).toBeNull();
  });
});

describe('playAt', () => {
  it('lance le flux normal avec resume none et la position de départ', () => {
    const launch = fakeLaunch();
    const toast = vi.fn();
    const ok = playAt({ launch, toast }, { type: 'series', tmdbId: 7, title: 'Severance', season: 1, episode: 3 }, 754);
    expect(ok).toBe(true);
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ type: 'tv', key: 'tv:7', season: 1, episode: 3 }), null, {
      resume: 'none', startAt: 754,
    });
    expect(toast).not.toHaveBeenCalled();
  });

  it('série sans épisode : toast, rien ne se lance', () => {
    const launch = fakeLaunch();
    const toast = vi.fn();
    expect(playAt({ launch, toast }, { type: 'series', tmdbId: 7 }, 10)).toBe(false);
    expect(toast).toHaveBeenCalledWith(NOT_OPENABLE);
    expect(launch).not.toHaveBeenCalled();
  });

  it('erreur de lancement synchrone : toast FR', () => {
    const toast = vi.fn();
    const launch = vi.fn((..._args: unknown[]): never => { throw new Error('boom'); });
    expect(playAt({ launch, toast }, { type: 'movie', tmdbId: 5 }, 0)).toBe(false);
    expect(toast).toHaveBeenCalledWith(LAUNCH_ERROR);
  });

  it('erreur de lancement asynchrone : toast FR, sans rejet non géré', async () => {
    const toast = vi.fn();
    const launch = vi.fn((..._args: unknown[]): Promise<void> => Promise.reject(new Error('réseau')));
    expect(playAt({ launch, toast }, { type: 'movie', tmdbId: 5 }, 0)).toBe(true);
    await flush();
    expect(toast).toHaveBeenCalledWith(LAUNCH_ERROR);
  });

  it('position négative ou absente : démarrage à 0', () => {
    const launch = fakeLaunch();
    playAt({ launch, toast: vi.fn() }, { type: 'movie', tmdbId: 5 }, -4);
    expect(launch.mock.calls[0][2]).toEqual({ resume: 'none', startAt: 0 });
  });
});

describe('createWatchWithHandler', () => {
  it('ami qui ne regarde rien : toast FR, aucune lecture', () => {
    const launch = fakeLaunch();
    const toast = vi.fn();
    createWatchWithHandler({ launch, toast })(friend());
    expect(toast).toHaveBeenCalledWith('Greg ne regarde rien pour le moment.');
    expect(launch).not.toHaveBeenCalled();
  });

  it('fiche absente : toast FR générique', () => {
    const toast = vi.fn();
    createWatchWithHandler({ launch: vi.fn(), toast })(null);
    expect(toast).toHaveBeenCalledWith('Cet ami ne regarde rien pour le moment.');
  });

  it('ami qui regarde : même titre et épisode, position estimée à l’instant du clic', () => {
    const launch = fakeLaunch();
    const now = 2_000_000;
    const f = friend({
      watching: { type: 'series', tmdbId: 7, title: 'Severance', season: 1, episode: 3, pos: 100, paused: false, at: now - 10_000 },
    });
    createWatchWithHandler({ launch, toast: vi.fn(), now: () => now })(f);
    expect(launch).toHaveBeenCalledTimes(1);
    const [request, , opts] = launch.mock.calls[0] as unknown as [{ key: string; season: number; episode: number }, unknown, { startAt: number; resume: string }];
    expect(request).toEqual(expect.objectContaining({ key: 'tv:7', season: 1, episode: 3, name: 'Severance' }));
    expect(opts.resume).toBe('none');
    expect(opts.startAt).toBeCloseTo(110, 5);
  });

  it('ami en pause : la position du relevé, sans avancer', () => {
    const launch = fakeLaunch();
    const f = friend({ watching: watching({ pos: 42, paused: true, at: 0 }) });
    createWatchWithHandler({ launch, toast: vi.fn(), now: () => 999_999 })(f);
    expect(launch.mock.calls[0][2]).toEqual({ resume: 'none', startAt: 42 });
  });
});
