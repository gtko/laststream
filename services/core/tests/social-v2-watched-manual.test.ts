import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, type Acting, befriend, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS } from './social-v2-harness.js';
import { request } from './user-harness.js';

/**
 * « Marqué vu » à la main (ODY-207), de bout en bout : PUT /watched n'apparaît ni dans l'historique récent de l'ami ni
 * dans son flux d'activité ; une vraie lecture, elle, y apparaît.
 */

interface WatchedBody {
  items: { type: string; tmdbId: number | null; watched: number }[];
}

interface HistoryBody {
  items: { tmdbId: number; season?: number; episode?: number; watched: boolean }[];
}

interface ActivityBody {
  items: { pid: string; kind: string; media: { tmdbId: number } }[];
}

const NOW = '2026-05-01T10:00:00.000Z';

let app: RunningApp;
let cast: Cast;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  app = await startApp({});
  cast = await castOf(app);
  await befriend(app, cast.alice, cast.bob);
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

const markWatched = (body: Record<string, unknown>) =>
  request(app, 'PUT', `/user/profiles/${cast.alice.profile}/watched`, { token: cast.alice.token, body });
const writeProgress = (body: Record<string, unknown>) =>
  request(app, 'PUT', `/user/profiles/${cast.alice.profile}/progress`, { token: cast.alice.token, body });
const myWatched = () => request<WatchedBody>(app, 'GET', `/user/profiles/${cast.alice.profile}/watched`, { token: cast.alice.token });
const historyOf = (who: Acting, pid: string) => as<HistoryBody & ErrorBodyV2>(app, who, 'GET', `/user/social/friends/${pid}/history`);
const feedOf = (who: Acting) => as<ActivityBody & ErrorBodyV2>(app, who, 'GET', '/user/social/activity');

describe('vu manuel (PUT /user/profiles/:id/watched) : hors historique et flux des amis', () => {
  it('un film et une saison marqués vus : dans mes vus, absents de l’historique de l’ami', async () => {
    expect((await markWatched({ type: 'movie', tmdbId: 603, watched: true })).status).toBe(204);
    expect(
      (
        await markWatched({
          type: 'series',
          tmdbId: 1399,
          episodes: [
            { season: 1, episode: 1 },
            { season: 1, episode: 2 },
          ],
          watched: true,
        })
      ).status,
    ).toBe(204);

    const mine = await myWatched();
    expect(mine.body.items.map((item) => item.tmdbId)).toEqual(expect.arrayContaining([603, 1399]));
    const theirs = await historyOf(cast.bob, cast.alice.pid);
    expect(theirs.status).toBe(200);
    expect(theirs.body.items).toEqual([]);
  });

  it('une lecture terminée (PUT /progress) reste visible dans l’historique de l’ami, avec son état vu', async () => {
    expect((await writeProgress({ type: 'movie', tmdbId: 680, positionSec: 7000, durationSec: 7200 })).status).toBe(200);
    const theirs = await historyOf(cast.bob, cast.alice.pid);
    expect(theirs.body.items).toEqual([expect.objectContaining({ tmdbId: 680, watched: true })]);
  });

  it('un épisode réellement terminé puis marqué vu à la main reste visible chez l’ami', async () => {
    expect((await writeProgress({ type: 'series', tmdbId: 1399, season: 1, episode: 1, positionSec: 2900, durationSec: 3000 })).status).toBe(200);
    expect((await markWatched({ type: 'series', tmdbId: 1399, episodes: [{ season: 1, episode: 1 }], watched: true })).status).toBe(204);

    const theirs = await historyOf(cast.bob, cast.alice.pid);
    expect(theirs.body.items).toEqual([expect.objectContaining({ tmdbId: 1399, season: 1, episode: 1, watched: true })]);
  });

  it('le flux d’activité ignore le marquage manuel ; une vraie lecture y figure (contrôle non vide)', async () => {
    await markWatched({ type: 'movie', tmdbId: 603, watched: true });
    await markWatched({ type: 'series', tmdbId: 1399, episodes: [{ season: 1, episode: 2 }], watched: true });
    expect((await feedOf(cast.bob)).body.items).toEqual([]);

    expect((await writeProgress({ type: 'movie', tmdbId: 603, positionSec: 100, durationSec: 7200 })).status).toBe(200);
    const items = (await feedOf(cast.bob)).body.items;
    expect(items).toEqual([expect.objectContaining({ pid: cast.alice.pid, kind: 'started', media: expect.objectContaining({ tmdbId: 603 }) })]);
  });
});
