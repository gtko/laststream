import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeProgressResponse, HomeWatchingResponse } from '@laststream/protocol/social';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, type Acting, befriend, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS } from './social-v2-harness.js';
import { request } from './user-harness.js';

/**
 * Accueil social (LAST-191) : « Ce que regardent tes amis » (GET /user/social/home/watching) et progression des amis sur les
 * titres de « Reprendre » (GET /user/social/home/progress). Un seul garde-fou (friendGate) : chaque règle a une assertion
 * « absent » et un témoin « présent », vérifiés sur les deux routes.
 */

const NOW_MS = Date.parse('2026-05-01T10:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Titres interrogés par la route de progression : films 603 et 680, série 1399. */
const TITLES = 'movie:603,movie:680,series:1399';

let app: RunningApp;
let cast: Cast;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  app = await startApp({});
  cast = await castOf(app);
  await befriend(app, cast.alice, cast.bob);
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

/**
 * Écrit une progression pour `who` à l'instant `ms` (PUT /user/profiles/:id/progress), puis remet l'horloge à NOW : les lectures
 * qui suivent se font toujours à NOW, sauf indication contraire.
 */
async function playAt(who: Acting, ms: number, body: Record<string, unknown>): Promise<void> {
  vi.setSystemTime(ms);
  const res = await request(app, 'PUT', `/user/profiles/${who.profile}/progress`, { token: who.token, body });
  vi.setSystemTime(NOW_MS);
  expect(res.status).toBe(200);
}

const movie = (tmdbId: number) => ({ type: 'movie', tmdbId, positionSec: 600, durationSec: 7200 });
const episode = (tmdbId: number, season: number, episodeNo: number, positionSec = 600) => ({
  type: 'series',
  tmdbId,
  season,
  episode: episodeNo,
  positionSec,
  durationSec: 2700,
});

const watchingOf = (who: Acting, query = '') => as<HomeWatchingResponse & ErrorBodyV2>(app, who, 'GET', `/user/social/home/watching${query}`);
const progressOf = (who: Acting, titles = TITLES) =>
  as<HomeProgressResponse & ErrorBodyV2>(app, who, 'GET', `/user/social/home/progress?titles=${titles}`);

/** Pids vus par `who` sur chacune des deux routes (pour les titres TITLES). Les deux réponses doivent être 200. */
async function seenBy(who: Acting): Promise<{ watching: string[]; progress: string[] }> {
  const watching = await watchingOf(who);
  const progress = await progressOf(who);
  expect(watching.status).toBe(200);
  expect(progress.status).toBe(200);
  return {
    watching: watching.body.items.map((item) => item.friend.pid),
    progress: progress.body.items.map((item) => item.friend.pid),
  };
}

const NOBODY = { watching: [], progress: [] };

describe('témoin : un ami accepté qui regarde', () => {
  it('apparaît sur les deux routes avec sa dernière progression', async () => {
    await playAt(cast.bob, NOW_MS - HOUR, movie(603));
    expect(await seenBy(cast.alice)).toEqual({ watching: [cast.bob.pid], progress: [cast.bob.pid] });
  });
});

describe('blocage, dans les deux sens', () => {
  it('un ami que je bloque disparaît des deux routes', async () => {
    await playAt(cast.bob, NOW_MS - HOUR, movie(603));
    expect((await seenBy(cast.alice)).watching).toContain(cast.bob.pid);
    expect((await as(app, cast.alice, 'POST', `/user/social/blocks/${cast.bob.pid}`)).status).toBe(204);
    expect(await seenBy(cast.alice)).toEqual(NOBODY);
  });

  it('un profil qui m a bloqué disparaît des deux routes', async () => {
    await playAt(cast.bob, NOW_MS - HOUR, movie(603));
    expect((await seenBy(cast.alice)).progress).toContain(cast.bob.pid);
    expect((await as(app, cast.bob, 'POST', `/user/social/blocks/${cast.alice.pid}`)).status).toBe(204);
    expect(await seenBy(cast.alice)).toEqual(NOBODY);
  });
});

describe('statut invisible de l ami', () => {
  it('invisible : absent des deux routes ; de retour en « away » : présent', async () => {
    await playAt(cast.bob, NOW_MS - HOUR, movie(603));
    expect((await seenBy(cast.alice)).watching).toContain(cast.bob.pid);
    await as(app, cast.bob, 'PUT', '/user/social/status', { body: { status: 'invisible' } });
    expect(await seenBy(cast.alice)).toEqual(NOBODY);
    await as(app, cast.bob, 'PUT', '/user/social/status', { body: { status: 'away' } });
    expect(await seenBy(cast.alice)).toEqual({ watching: [cast.bob.pid], progress: [cast.bob.pid] });
  });
});

describe('lecteur enfant', () => {
  it('un profil enfant n a aucune route d accueil : 403 sur les deux', async () => {
    const watching = await as<ErrorBodyV2>(app, cast.kid, 'GET', '/user/social/home/watching');
    const progress = await as<ErrorBodyV2>(app, cast.kid, 'GET', `/user/social/home/progress?titles=${TITLES}`);
    expect(watching.status).toBe(403);
    expect(watching.body.error).toBe('kid_profile');
    expect(progress.status).toBe(403);
    expect(progress.body.error).toBe('kid_profile');
  });
});

describe('non-amis', () => {
  it('un profil sans lien, puis une demande en attente, sont absents ; présent une fois accepté', async () => {
    await playAt(cast.carol, NOW_MS - HOUR, movie(603));
    expect((await seenBy(cast.alice)).watching).not.toContain(cast.carol.pid);

    expect((await as(app, cast.alice, 'POST', '/user/social/requests', { body: { handle: cast.carol.full } })).status).toBe(201);
    expect((await seenBy(cast.alice)).progress).not.toContain(cast.carol.pid);

    expect((await as(app, cast.carol, 'POST', `/user/social/requests/${cast.alice.pid}/accept`)).status).toBe(200);
    expect((await seenBy(cast.alice)).watching).toContain(cast.carol.pid);
    expect((await seenBy(cast.alice)).progress).toContain(cast.carol.pid);
  });
});

describe('profil enfant', () => {
  it('la progression d un profil enfant n apparaît jamais, alors que mes amis apparaissent', async () => {
    await playAt(cast.bob, NOW_MS - HOUR, movie(603));
    const kid = await request(app, 'PUT', `/user/profiles/${cast.kid.profile}/progress`, { token: cast.kid.token, body: movie(680) });
    expect(kid.status).toBe(200);
    const progress = await progressOf(cast.alice, 'movie:680,movie:603');
    expect(progress.body.items.map((item) => item.friend.pid)).toEqual([cast.bob.pid]);
    expect((await seenBy(cast.alice)).watching).toEqual([cast.bob.pid]);
  });
});

describe('foyer', () => {
  it('un profil du même compte n est jamais listé, moi non plus', async () => {
    await playAt(cast.bob, NOW_MS - HOUR, movie(603));
    await playAt(cast.alice2, NOW_MS - 10 * MINUTE, movie(680));
    await playAt(cast.alice, NOW_MS - 5 * MINUTE, movie(603));
    expect(await seenBy(cast.alice)).toEqual({ watching: [cast.bob.pid], progress: [cast.bob.pid] });
  });
});

describe('réglages de l ami', () => {
  it('historique masqué (historyVisible faux) : absent des deux routes', async () => {
    await playAt(cast.bob, NOW_MS - HOUR, movie(603));
    expect((await seenBy(cast.alice)).progress).toContain(cast.bob.pid);
    await as(app, cast.bob, 'PUT', '/user/social/prefs', { body: { historyVisible: false } });
    expect(await seenBy(cast.alice)).toEqual(NOBODY);
  });

  it('activité « nobody » : absent des deux routes', async () => {
    await playAt(cast.bob, NOW_MS - HOUR, movie(603));
    await as(app, cast.bob, 'PUT', '/user/social/prefs', { body: { activityVisibility: 'nobody' } });
    expect(await seenBy(cast.alice)).toEqual(NOBODY);
    await as(app, cast.bob, 'PUT', '/user/social/prefs', { body: { activityVisibility: 'friends' } });
    expect((await seenBy(cast.alice)).watching).toContain(cast.bob.pid);
  });

  it('activité « favorites » : absent tant que je ne suis pas son favori, présent ensuite', async () => {
    await playAt(cast.bob, NOW_MS - HOUR, movie(603));
    await as(app, cast.bob, 'PUT', '/user/social/prefs', { body: { activityVisibility: 'favorites' } });
    expect(await seenBy(cast.alice)).toEqual(NOBODY);
    expect((await as(app, cast.bob, 'PUT', `/user/social/friends/${cast.alice.pid}/relation`, { body: { favorite: true } })).status).toBe(200);
    expect(await seenBy(cast.alice)).toEqual({ watching: [cast.bob.pid], progress: [cast.bob.pid] });
  });

  it('sourdine posée par moi (muted) : absent des deux routes', async () => {
    await playAt(cast.bob, NOW_MS - HOUR, movie(603));
    expect((await as(app, cast.alice, 'PUT', `/user/social/friends/${cast.bob.pid}/relation`, { body: { muted: true } })).status).toBe(200);
    expect(await seenBy(cast.alice)).toEqual(NOBODY);
    await as(app, cast.alice, 'PUT', `/user/social/friends/${cast.bob.pid}/relation`, { body: { muted: false } });
    expect((await seenBy(cast.alice)).progress).toContain(cast.bob.pid);
  });

  it('masquage d activité posé par moi (hideActivity) : absent des deux routes', async () => {
    await playAt(cast.bob, NOW_MS - HOUR, movie(603));
    expect((await as(app, cast.alice, 'PUT', `/user/social/friends/${cast.bob.pid}/relation`, { body: { hideActivity: true } })).status).toBe(200);
    expect(await seenBy(cast.alice)).toEqual(NOBODY);
    await as(app, cast.alice, 'PUT', `/user/social/friends/${cast.bob.pid}/relation`, { body: { hideActivity: false } });
    expect((await seenBy(cast.alice)).watching).toContain(cast.bob.pid);
  });
});

describe('vu marqué à la main', () => {
  it('un titre marqué vu à la main (manual) n alimente ni l une ni l autre route', async () => {
    vi.setSystemTime(NOW_MS - 30 * MINUTE);
    const marked = await request(app, 'PUT', `/user/profiles/${cast.bob.profile}/watched`, {
      token: cast.bob.token,
      body: { type: 'movie', tmdbId: 603, watched: true },
    });
    expect(marked.status).toBe(204);
    await playAt(cast.bob, NOW_MS - HOUR, movie(680));

    const watching = await watchingOf(cast.alice);
    expect(watching.body.items.map((item) => item.media.tmdbId)).toEqual([680]);
    expect((await progressOf(cast.alice, 'movie:603')).body.items).toEqual([]);
    expect((await progressOf(cast.alice, 'movie:680')).body.items.map((item) => item.friend.pid)).toEqual([cast.bob.pid]);
  });
});

describe('fenêtre de 30 jours', () => {
  it('une progression de plus de 30 jours est absente des deux routes', async () => {
    await playAt(cast.bob, NOW_MS - 31 * DAY, movie(603));
    expect(await seenBy(cast.alice)).toEqual(NOBODY);
  });

  it('une progression de moins de 30 jours est présente sur les deux routes', async () => {
    await playAt(cast.bob, NOW_MS - 29 * DAY, movie(603));
    expect(await seenBy(cast.alice)).toEqual({ watching: [cast.bob.pid], progress: [cast.bob.pid] });
  });
});

describe('une entrée par ami, tri et forme', () => {
  it('une entrée par ami (sa progression la plus récente), triées par date décroissante', async () => {
    await befriend(app, cast.alice, cast.carol);
    await playAt(cast.bob, NOW_MS - 2 * HOUR, movie(603));
    await playAt(cast.bob, NOW_MS - HOUR, episode(1399, 1, 1));
    await playAt(cast.carol, NOW_MS - 30 * MINUTE, movie(603));

    const { status, body } = await watchingOf(cast.alice);
    expect(status).toBe(200);
    expect(body.items.map((item) => [item.friend.pid, item.updatedAt])).toEqual([
      [cast.carol.pid, NOW_MS - 30 * MINUTE],
      [cast.bob.pid, NOW_MS - HOUR],
    ]);
    expect(body.items[1]?.media).toEqual({ type: 'series', tmdbId: 1399, season: 1, episode: 1 });
  });

  it('limite : `limit=1` ne rend que l entrée la plus récente ; 0 ou plus de 50 : 400', async () => {
    await befriend(app, cast.alice, cast.carol);
    await playAt(cast.bob, NOW_MS - HOUR, movie(603));
    await playAt(cast.carol, NOW_MS - 30 * MINUTE, movie(603));
    const one = await watchingOf(cast.alice, '?limit=1');
    expect(one.body.items.map((item) => item.friend.pid)).toEqual([cast.carol.pid]);
    expect((await watchingOf(cast.alice, '?limit=0')).status).toBe(400);
    expect((await watchingOf(cast.alice, '?limit=51')).status).toBe(400);
  });

  it('friend ne porte que pid, handle et couleur, avec le surnom posé par moi ; live suit le titre en cours de l ami', async () => {
    await playAt(cast.bob, NOW_MS - HOUR, movie(603));
    await request(app, 'PUT', `/user/profiles/${cast.bob.profile}/library/movie/603`, {
      token: cast.bob.token,
      body: { title: 'Matrix', poster: 'https://image.example/matrix.jpg' },
    });
    await as(app, cast.alice, 'PUT', `/user/social/friends/${cast.bob.pid}/relation`, { body: { nickname: 'Bobby' } });

    const before = (await watchingOf(cast.alice)).body.items[0];
    expect(before).toBeDefined();
    expect(Object.keys(before ?? {}).sort()).toEqual(['duration', 'finished', 'friend', 'live', 'media', 'pos', 'updatedAt']);
    expect(Object.keys(before?.friend ?? {}).sort()).toEqual(['avatarColor', 'handle', 'nickname', 'pid']);
    expect(before).toMatchObject({
      friend: { pid: cast.bob.pid, nickname: 'Bobby', handle: { full: cast.bob.full } },
      media: { type: 'movie', tmdbId: 603, title: 'Matrix', poster: 'https://image.example/matrix.jpg' },
      pos: 600,
      duration: 7200,
      finished: false,
      live: false,
    });

    vi.setSystemTime(NOW_MS);
    const heartbeat = await as(app, cast.bob, 'PUT', '/user/social/presence', {
      body: { watching: { type: 'movie', tmdbId: 603, title: 'Matrix', pos: 600, duration: 7200, paused: false, at: NOW_MS } },
    });
    expect(heartbeat.status).toBe(204);
    expect((await watchingOf(cast.alice)).body.items[0]?.live).toBe(true);
  });

  it('sans bibliothèque, titre et affiche sont absents', async () => {
    await playAt(cast.bob, NOW_MS - HOUR, movie(603));
    const media = (await watchingOf(cast.alice)).body.items[0]?.media;
    expect(media).toEqual({ type: 'movie', tmdbId: 603 });
  });
});

describe('progression par titre (/home/progress)', () => {
  it('la progression la plus avancée du titre : saison, puis épisode, puis position', async () => {
    await playAt(cast.bob, NOW_MS - 2 * HOUR, episode(1399, 1, 9, 100));
    await playAt(cast.bob, NOW_MS - HOUR, episode(1399, 2, 1, 10));
    const { body } = await progressOf(cast.alice, 'series:1399');
    expect(body.items).toEqual([
      expect.objectContaining({
        friend: expect.objectContaining({ pid: cast.bob.pid }),
        type: 'series',
        tmdbId: 1399,
        season: 2,
        episode: 1,
        pos: 10,
        updatedAt: NOW_MS - HOUR,
      }),
    ]);
  });

  it('titres : 20 au plus, au format type:tmdbId ; sinon 400 ; titre absent du paramètre : 400', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `movie:${i + 1}`).join(',');
    expect((await progressOf(cast.alice, twenty)).status).toBe(200);
    expect((await progressOf(cast.alice, `${twenty},movie:21`)).status).toBe(400);
    for (const bad of ['series:abc', 'film:603', 'movie', 'movie:0', 'movie:603,']) {
      expect((await progressOf(cast.alice, bad)).status).toBe(400);
    }
    expect((await as(app, cast.alice, 'GET', '/user/social/home/progress')).status).toBe(400);
  });
});
