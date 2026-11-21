import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ setProgress: vi.fn(), setWatched: vi.fn(async () => true) }));
vi.mock('../src/data/userStore', () => ({ userStore: store }));

import {
  beginExternalWatch, dropPendingExternalWatch, estimateExternal, externalDuration, noteExternalLeft, settleExternalWatch, type ExternalWatch,
} from '../src/player/externalWatch';

/* Lecture dans VLC : position estimée au retour, « vu » à 80 % ou au générique. */

const EP = { key: 'tv:1399', type: 'tv' as const, id: 1399, title: 'Série', poster: '', season: 1, episode: 2 };
const MIN = 60_000;
const watch = (over: Partial<ExternalWatch> = {}): ExternalWatch => ({ entry: EP, duration: 3000, startedAt: 0, offset: 0, left: true, ...over });

describe('estimateExternal', () => {
  it('position = temps passé hors de l’app', () => {
    expect(estimateExternal(watch(), 20 * MIN)).toEqual({ position: 1200, duration: 3000, watched: false });
  });

  it('80 % de la durée : vu', () => {
    expect(estimateExternal(watch(), 40 * MIN)?.watched).toBe(true);
  });

  it('au générique (moins de deux minutes de la fin) : vu, même sous 80 %', () => {
    expect(estimateExternal(watch({ duration: 400 }), 5 * MIN)?.watched).toBe(true);
  });

  it('relance depuis le même écran : la position de départ s’ajoute, plafonnée à la durée', () => {
    expect(estimateExternal(watch({ offset: 1000 }), 10 * MIN)?.position).toBe(1600);
    expect(estimateExternal(watch({ offset: 2900 }), 10 * MIN)?.position).toBe(3000);
  });

  it('page jamais quittée, absence de moins d’une minute ou durée inconnue : rien', () => {
    expect(estimateExternal(watch({ left: false }), 20 * MIN)).toBeNull();
    expect(estimateExternal(watch(), 30_000)).toBeNull();
    expect(estimateExternal(watch({ duration: 0 }), 20 * MIN)).toBeNull();
  });
});

describe('externalDuration', () => {
  it('durée TMDB (minutes), sinon estimation de la source, sinon 0', () => {
    expect(externalDuration(45, 1000)).toBe(2700);
    expect(externalDuration(null, 1000)).toBe(1000);
    expect(externalDuration(0, null)).toBe(0);
  });
});

describe('suivi stocké (begin / left / settle)', () => {
  beforeEach(() => { localStorage.clear(); store.setProgress.mockClear(); store.setWatched.mockClear(); });

  it('retour à mi-épisode : position enregistrée, pas de « vu »', () => {
    beginExternalWatch(EP, 3000, 0, 0);
    noteExternalLeft(0);
    const est = settleExternalWatch(20 * MIN);
    expect(est?.position).toBe(1200);
    expect(store.setProgress).toHaveBeenCalledWith(expect.objectContaining({ key: 'tv:1399', season: 1, episode: 2, position: 1200, duration: 3000 }));
    expect(store.setWatched).not.toHaveBeenCalled();
    expect(settleExternalWatch(30 * MIN)).toBeNull(); // déjà réglé
  });

  it('retour après 80 % : épisode vu, position en fin pour proposer la suite', () => {
    beginExternalWatch(EP, 3000, 0, 0);
    noteExternalLeft(0);
    expect(settleExternalWatch(45 * MIN)?.watched).toBe(true);
    expect(store.setProgress).toHaveBeenCalledWith(expect.objectContaining({ position: 3000 }));
    expect(store.setWatched).toHaveBeenCalledWith('tv:1399', [{ season: 1, episode: 2 }], true);
  });

  it('le temps passé dans l’app avant de partir ne compte pas', () => {
    beginExternalWatch(EP, 3000, 0, 0);
    noteExternalLeft(10 * MIN);
    expect(settleExternalWatch(30 * MIN)?.position).toBe(1200);
  });

  it('VLC jamais ouvert (page restée visible) : rien n’est compté, et la fermeture de l’écran abandonne le suivi', () => {
    beginExternalWatch(EP, 3000, 0, 0);
    expect(settleExternalWatch(60 * MIN)).toBeNull();
    dropPendingExternalWatch();
    noteExternalLeft(60 * MIN);
    expect(settleExternalWatch(120 * MIN)).toBeNull();
    expect(store.setProgress).not.toHaveBeenCalled();
  });
});
