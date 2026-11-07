import { describe, expect, it } from 'vitest';
import { addonNextEpisode, addonOf, addonProgressKey, addonResumeSource, addonStreamIdOf, addonVideoOf } from '../src/player/addonRequest';

const videos = [
  { id: 'v-2-1', season: 2, episode: 1 }, { id: 'v-1-2', season: 1, episode: 2 }, { id: 'v-1-1', season: 1, episode: 1 },
  { id: 'special', season: 0, episode: 1 }, { id: 'sans-numero' },
];

describe('addonRequest', () => {
  it('addonOf : seulement avec clé et base', () => {
    expect(addonOf({})).toBeNull();
    expect(addonOf({ addon: { key: 'k' } })).toBeNull();
    expect(addonOf({ addon: { key: 'addon:anime:fk:1', base: 'https://a.test', type: 'anime', id: 'fk:1', title: 'T' } })).toEqual({ key: 'addon:anime:fk:1', base: 'https://a.test', type: 'anime', id: 'fk:1', title: 'T' });
  });

  it('clé de progression : addon:type:id', () => {
    expect(addonProgressKey({ type: 'anime', id: 'fk:1' })).toBe('addon:anime:fk:1');
  });

  it('épisode suivant : dans la saison, puis saison suivante, puis fin', () => {
    expect(addonNextEpisode(videos, { season: 1, episode: 1 })).toEqual({ season: 1, episode: 2 });
    expect(addonNextEpisode(videos, { season: 1, episode: 2 })).toEqual({ season: 2, episode: 1 });
    expect(addonNextEpisode(videos, { season: 2, episode: 1 })).toBeNull();
  });

  it('épisode suivant désactivé sans liste, sans épisode courant ou épisode inconnu', () => {
    expect(addonNextEpisode(undefined, { season: 1, episode: 1 })).toBeNull();
    expect(addonNextEpisode(videos, {})).toBeNull();
    expect(addonNextEpisode(videos, { season: 9, episode: 9 })).toBeNull();
  });

  it('identifiant de flux : celui de l’épisode, sinon celui de la fiche', () => {
    const addon = { key: 'k', base: 'https://a.test', type: 'anime', id: 'fk:1', title: 'T' };
    expect(addonStreamIdOf({ addon })).toBe('fk:1');
    expect(addonStreamIdOf({ addon, streamId: 'v-1-2' })).toBe('v-1-2');
    expect(addonVideoOf(videos, 1, 2)?.id).toBe('v-1-2');
    expect(addonVideoOf(videos, 5, 5)).toBeUndefined();
  });

  it('reprise : même épisode (ou film) seulement', () => {
    const saved = { t: 100, d: 1000, episode: { season: 1, episode: 2 } };
    expect(addonResumeSource(saved, { season: 1, episode: 2 })).toEqual({ position: 100, duration: 1000 });
    expect(addonResumeSource(saved, { season: 1, episode: 3 })).toBeNull();
    expect(addonResumeSource({ t: 5, d: 50 }, {})).toEqual({ position: 5, duration: 50 });
    expect(addonResumeSource(null, {})).toBeNull();
  });
});
