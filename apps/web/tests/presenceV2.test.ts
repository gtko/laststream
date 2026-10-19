// Présence v2 du lecteur (Social v2, lot 4b) : construction du relevé, politique d'émission, saut de lecture, et contrôleur
// (titre au démarrage, pause et saut après le délai minimal, battement de 25 s, invisible, profil enfant, erreurs silencieuses).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_MS, DEBOUNCE_MS, HEARTBEAT_MS, buildWatching, isJump, mediaKey, presenceTick, reasonFor, setPresenceMedia, setPresenceSender,
  setPresenceStatusSource, startPresenceV2, stopPresenceV2, type MediaInfo,
} from '../src/player/presenceV2';

const MOVIE: MediaInfo = { type: 'movie', tmdbId: 603, title: 'Matrix', imdbId: 'tt0133093', poster: '/abc.jpg' };
const EPISODE: MediaInfo = { type: 'series', tmdbId: 95396, title: 'Severance', season: 2, episode: 4 };

describe('buildWatching', () => {
  it('film : position au dixième, durée connue, ni saison ni épisode', () => {
    expect(buildWatching(MOVIE, { time: 12.345, duration: 8160.04, paused: false }, 1000)).toEqual({
      type: 'movie', tmdbId: 603, title: 'Matrix', imdbId: 'tt0133093', poster: '/abc.jpg',
      pos: 12.3, duration: 8160, paused: false, at: 1000,
    });
  });

  it('série : saison et épisode, pause conservée', () => {
    const w = buildWatching(EPISODE, { time: 754, paused: true }, 5);
    expect(w).toEqual({ type: 'series', tmdbId: 95396, title: 'Severance', season: 2, episode: 4, pos: 754, paused: true, at: 5 });
  });

  it('position invalide ramenée à 0 ; durée absente ou nulle omise ; saison ignorée pour un film', () => {
    const w = buildWatching({ ...MOVIE, season: 3 } as MediaInfo, { time: Number.NaN, duration: 0, paused: true }, 5);
    expect(w.pos).toBe(0);
    expect('duration' in w).toBe(false);
    expect('season' in w).toBe(false);
  });

  it('clé de média : même titre et même épisode, clé différente au changement d’épisode', () => {
    expect(mediaKey(EPISODE)).toBe(mediaKey({ ...EPISODE }));
    expect(mediaKey(EPISODE)).not.toBe(mediaKey({ ...EPISODE, episode: 5 }));
    expect(mediaKey(null)).toBe('');
  });
});

describe('saut de lecture', () => {
  it('lecture normale : pas de saut', () => {
    expect(isJump({ time: 10, at: 0, paused: false }, 10.1, 100, 1)).toBe(false);
  });

  it('avance de 30 s d’un coup : saut', () => {
    expect(isJump({ time: 10, at: 0, paused: false }, 40, 100, 1)).toBe(true);
  });

  it('recul de 10 s : saut', () => {
    expect(isJump({ time: 60, at: 0, paused: false }, 50, 100, 1)).toBe(true);
  });

  it('en pause, la position ne bouge pas : pas de saut', () => {
    expect(isJump({ time: 50, at: 0, paused: true }, 50, 5000, 1)).toBe(false);
  });

  it('débit 2× : la position avance deux fois plus vite, pas de saut', () => {
    expect(isJump({ time: 10, at: 0, paused: false }, 20, 5000, 2)).toBe(false);
  });
});

describe('politique d’émission', () => {
  const last = { key: 'movie:603::', paused: false, at: 0 };

  it('premier envoi, puis tout changement de média : immédiat', () => {
    expect(reasonFor(null, { key: '', paused: false, pending: false, now: 0 })).toBe('media');
    expect(reasonFor(last, { key: 'movie:1::', paused: false, pending: false, now: 1 })).toBe('media');
  });

  it('pause ou saut : après le délai minimal seulement', () => {
    expect(reasonFor(last, { key: last.key, paused: true, pending: false, now: DEBOUNCE_MS - 1 })).toBeNull();
    expect(reasonFor(last, { key: last.key, paused: true, pending: false, now: DEBOUNCE_MS })).toBe('state');
    expect(reasonFor(last, { key: last.key, paused: false, pending: true, now: DEBOUNCE_MS })).toBe('state');
  });

  it('battement : une fois le délai de 25 s échu, sans changement', () => {
    expect(reasonFor(last, { key: last.key, paused: false, pending: false, now: HEARTBEAT_MS - 1 })).toBeNull();
    expect(reasonFor(last, { key: last.key, paused: false, pending: false, now: HEARTBEAT_MS })).toBe('heartbeat');
  });

  it('le battement reste inférieur au seuil de 30 s du contrat', () => {
    expect(HEARTBEAT_MS).toBeLessThanOrEqual(30_000);
    expect(CHECK_MS).toBeLessThan(HEARTBEAT_MS);
  });
});

// ---- Contrôleur ----
type Put = (w: unknown) => Promise<unknown>;

describe('contrôleur de présence', () => {
  let put: ReturnType<typeof vi.fn>;
  let del: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    put = vi.fn(async () => undefined);
    del = vi.fn(async () => undefined);
    setPresenceSender({ put: put as unknown as Put, del: del as unknown as () => Promise<unknown> });
    setPresenceStatusSource(() => 'online');
  });

  afterEach(() => {
    stopPresenceV2(false);
    setPresenceSender(null);
    setPresenceStatusSource(null);
    vi.useRealTimers();
  });

  it('démarrage hors titre, titre dès le premier relevé de lecture, fermeture hors ligne', () => {
    startPresenceV2(false);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenLastCalledWith(null);

    setPresenceMedia(MOVIE);
    expect(put).toHaveBeenCalledTimes(1); // attend le premier relevé
    presenceTick({ time: 100, duration: 7200, paused: false });
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1][0]).toMatchObject({ type: 'movie', tmdbId: 603, title: 'Matrix', pos: 100, duration: 7200, paused: false });

    setPresenceMedia(null);
    expect(put).toHaveBeenCalledTimes(3);
    expect(put.mock.calls[2][0]).toBeNull();

    stopPresenceV2();
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('pause envoyée après le délai minimal, saut fusionné dans une rafale', () => {
    startPresenceV2(false);
    setPresenceMedia(MOVIE);
    presenceTick({ time: 100, paused: false }); // t=0 : titre
    expect(put).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(100);
    presenceTick({ time: 100.1, paused: false }); // lecture normale
    vi.advanceTimersByTime(100);
    presenceTick({ time: 500, paused: false }); // saut de 400 s en 100 ms : en attente (délai minimal)
    expect(put).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(800);
    presenceTick({ time: 500.8, paused: false }); // t=1000 : le saut part, position à jour
    expect(put).toHaveBeenCalledTimes(3);
    expect(put.mock.calls[2][0]).toMatchObject({ pos: 500.8, paused: false });

    vi.advanceTimersByTime(200);
    presenceTick({ time: 501, paused: true }); // pause : après 1 s depuis le dernier envoi seulement
    expect(put).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(DEBOUNCE_MS);
    presenceTick({ time: 501, paused: true });
    expect(put).toHaveBeenCalledTimes(4);
    expect(put.mock.calls[3][0]).toMatchObject({ pos: 501, paused: true });
  });

  it('battement hors lecture : toutes les 25 s au plus, plus rien après l’arrêt', () => {
    startPresenceV2(false);
    expect(put).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(put).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(HEARTBEAT_MS * 2);
    expect(put).toHaveBeenCalledTimes(4);

    stopPresenceV2();
    expect(del).toHaveBeenCalledTimes(1);
    const calls = put.mock.calls.length;
    vi.advanceTimersByTime(HEARTBEAT_MS * 4);
    expect(put.mock.calls.length).toBe(calls);
  });

  it('statut invisible : rien n’est envoyé, ni titre ni fermeture ; reprise à la sortie du mode invisible', () => {
    let status: 'online' | 'invisible' = 'invisible';
    setPresenceStatusSource(() => status);
    startPresenceV2(false);
    setPresenceMedia(MOVIE);
    presenceTick({ time: 10, paused: false });
    vi.advanceTimersByTime(HEARTBEAT_MS * 2);
    stopPresenceV2();
    expect(put).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();

    status = 'online';
    startPresenceV2(false);
    expect(put).toHaveBeenCalledTimes(1);
    setPresenceMedia(MOVIE);
    presenceTick({ time: 10, paused: false });
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1][0]).toMatchObject({ tmdbId: 603, pos: 10 });
  });

  it('profil enfant : aucun appel, ni titre, ni battement, ni fermeture', () => {
    startPresenceV2(true);
    setPresenceMedia(MOVIE);
    presenceTick({ time: 10, paused: false });
    vi.advanceTimersByTime(HEARTBEAT_MS * 3);
    stopPresenceV2();
    expect(put).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('erreurs réseau silencieuses : la lecture n’est pas interrompue', () => {
    put.mockImplementation(() => Promise.reject(new Error('réseau coupé')));
    del.mockImplementation(() => Promise.reject(new Error('réseau coupé')));
    expect(() => {
      startPresenceV2(false);
      setPresenceMedia(MOVIE);
      presenceTick({ time: 10, paused: false });
      stopPresenceV2();
    }).not.toThrow();
    expect(put).toHaveBeenCalled();
  });
});
