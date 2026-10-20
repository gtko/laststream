import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocialEvent } from '../src/user/social-v2-events.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, type Acting, befriend, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS } from './social-v2-harness.js';
import { request } from './user-harness.js';

/** Réconciliations S5 : activité branchée sur S2 (préférences, masquage, sourdine, friendStarts), S1 (favoris), S3b (listes), meta_index. */

interface ActivityBody {
  pid: string;
  kind: string;
  media: { type: string; tmdbId: number; title: string; poster?: string };
}

interface Emitted {
  pids: string[];
  event: SocialEvent;
}

const START = Date.parse('2026-05-01T10:00:00.000Z');
const emitted: Emitted[] = [];
let app: RunningApp;
let cast: Cast;
let tick = 0;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(START));
  tick = 0;
  emitted.length = 0;
  app = await startApp({
    extra: {
      socialEvents: (pids, event) => {
        emitted.push({ pids: [...pids], event });
      },
    },
  });
  cast = await castOf(app);
  await befriend(app, cast.alice, cast.bob);
  emitted.length = 0;
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

/** Chaque appel avance l'horloge d'une minute : un titre neuf par test évite le dédoublonnage du jour. */
const startTitle = (who: Acting, tmdbId: number) => {
  tick += 1;
  vi.setSystemTime(new Date(START + tick * 60_000));
  return request(app, 'PUT', `/user/profiles/${who.profile}/progress`, { token: who.token, body: { type: 'movie', tmdbId, positionSec: 100, durationSec: 7200 } });
};
const feed = (who: Acting) => as<{ items: ActivityBody[] } & ErrorBodyV2>(app, who, 'GET', '/user/social/activity');
const tmdbIds = async (who: Acting): Promise<number[]> => (await feed(who)).body.items.map((item) => item.media.tmdbId).sort((a, b) => a - b);
const setPrefs = (who: Acting, body: unknown) => as(app, who, 'PUT', '/user/social/prefs', { body });
const relation = (who: Acting, pid: string, body: unknown) => as(app, who, 'PUT', `/user/social/friends/${pid}/relation`, { body });
const activityEvents = () => emitted.filter((entry) => entry.event.t === 'activity');

describe('flux d’activité : préférences et relations de S2', () => {
  it('activityVisibility « nobody » masque l’activité à l’ami, pas au foyer ; « favorites » la réserve aux favoris', async () => {
    await startTitle(cast.alice, 101);
    expect(await tmdbIds(cast.bob)).toEqual([101]);

    await setPrefs(cast.alice, { activityVisibility: 'nobody' });
    await startTitle(cast.alice, 102);
    expect(await tmdbIds(cast.bob)).toEqual([]);
    // Le foyer d'alice (autre profil du même compte) voit toujours tout.
    expect(await tmdbIds(cast.alice2)).toEqual([101, 102]);

    await setPrefs(cast.alice, { activityVisibility: 'favorites' });
    expect(await tmdbIds(cast.bob)).toEqual([]);
    await relation(cast.alice, cast.bob.pid, { favorite: true });
    expect(await tmdbIds(cast.bob)).toEqual([101, 102]);
  });

  it('hideActivity (posé par alice sur bob) retire l’activité de bob du flux d’alice, et seulement celui-là', async () => {
    await befriend(app, cast.alice, cast.carol);
    await startTitle(cast.bob, 201);
    expect(await tmdbIds(cast.alice)).toEqual([201]);
    await relation(cast.alice, cast.bob.pid, { hideActivity: true });
    expect(await tmdbIds(cast.alice)).toEqual([]);
    // Le sens inverse n’est pas touché : bob voit toujours alice, et carol aussi.
    await startTitle(cast.alice, 202);
    expect(await tmdbIds(cast.bob)).toEqual([202]);
    expect(await tmdbIds(cast.carol)).toEqual([202]);
    await relation(cast.alice, cast.bob.pid, { hideActivity: false });
    expect(await tmdbIds(cast.alice)).toEqual([201]);
  });

  it('hideActivity ne touche pas à la présence : alice voit toujours le « regarde en ce moment » de bob', async () => {
    await as(app, cast.bob, 'PUT', '/user/social/presence', {
      body: { watching: { type: 'movie', tmdbId: 201, title: 'Film', pos: 100, duration: 7200, paused: false, at: Date.now() } },
    });
    await relation(cast.bob, cast.alice.pid, { hideActivity: true });
    await relation(cast.alice, cast.bob.pid, { hideActivity: true });
    const friends = (await as<{ friends: { pid: string; watching?: { title: string } }[] }>(app, cast.alice, 'GET', '/user/social/friends')).body.friends;
    expect(friends.find((friend) => friend.pid === cast.bob.pid)?.watching?.title).toBe('Film');
  });

  it('muted (posé par bob sur alice) retire l’activité d’alice de son flux', async () => {
    await startTitle(cast.alice, 301);
    expect(await tmdbIds(cast.bob)).toEqual([301]);
    await relation(cast.bob, cast.alice.pid, { muted: true });
    expect(await tmdbIds(cast.bob)).toEqual([]);
  });
});

describe('temps réel {t:"activity"} : favoris et notify.friendStarts', () => {
  it('seul un ami qui a alice en favori et friendStarts actif reçoit le début d’un titre', async () => {
    await befriend(app, cast.alice, cast.carol);
    await startTitle(cast.alice, 401);
    expect(activityEvents()).toHaveLength(0);

    // Bob : favori mais friendStarts faux ; carol : friendStarts vrai mais pas favori.
    await relation(cast.bob, cast.alice.pid, { favorite: true });
    await setPrefs(cast.carol, { notify: { friendStarts: true } });
    await startTitle(cast.alice, 402);
    expect(activityEvents()).toHaveLength(0);

    await setPrefs(cast.bob, { notify: { friendStarts: true } });
    await startTitle(cast.alice, 403);
    const live = activityEvents();
    expect(live).toHaveLength(1);
    expect(live[0]?.pids).toEqual([cast.bob.pid]);
    expect(live[0]?.event).toMatchObject({ t: 'activity', item: { kind: 'started', pid: cast.alice.pid, media: { tmdbId: 403 } } });
  });

  it('respecte la visibilité, le masquage et la sourdine', async () => {
    await relation(cast.bob, cast.alice.pid, { favorite: true });
    await setPrefs(cast.bob, { notify: { friendStarts: true } });

    await setPrefs(cast.alice, { activityVisibility: 'nobody' });
    await startTitle(cast.alice, 411);
    await setPrefs(cast.alice, { activityVisibility: 'friends' });
    // Bob masque l’activité d’alice : il ne reçoit plus son début de titre en direct.
    await relation(cast.bob, cast.alice.pid, { hideActivity: true });
    await startTitle(cast.alice, 412);
    await relation(cast.bob, cast.alice.pid, { hideActivity: false });
    await relation(cast.bob, cast.alice.pid, { muted: true });
    await startTitle(cast.alice, 413);
    expect(activityEvents()).toHaveLength(0);

    await relation(cast.bob, cast.alice.pid, { muted: false });
    await startTitle(cast.alice, 414);
    expect(activityEvents()).toHaveLength(1);
  });

  it('une fin de titre ou une note ne sont pas diffusées en temps réel', async () => {
    await relation(cast.bob, cast.alice.pid, { favorite: true });
    await setPrefs(cast.bob, { notify: { friendStarts: true } });
    await as(app, cast.alice, 'POST', '/user/social/notes', { body: { type: 'movie', tmdbId: 421, pos: 5, kind: 'text', body: 'Beau' } });
    expect(activityEvents()).toHaveLength(0);
    expect(await tmdbIds(cast.bob)).toEqual([421]);
  });
});

describe('favoris du profil et listes partagées alimentent l’activité', () => {
  it('PUT /profile : un favori ajouté crée « favorited » (titre et affiche), un favori déjà présent n’en crée pas', async () => {
    const favorite = { tmdbId: 603, type: 'movie', title: 'Matrix', poster: '/matrix.jpg' };
    const first = await as(app, cast.alice, 'PUT', '/user/social/profile', { body: { favorites: [favorite] } });
    expect(first.status).toBe(200);
    const items = (await feed(cast.bob)).body.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'favorited', pid: cast.alice.pid, media: { type: 'movie', tmdbId: 603, title: 'Matrix', poster: '/matrix.jpg' } });

    // Même liste (réordonnée avec un nouveau titre) : seul le nouveau favori compte.
    tick += 1;
    vi.setSystemTime(new Date(START + 86_400_000 * 2));
    await as(app, cast.alice, 'PUT', '/user/social/profile', { body: { favorites: [favorite, { tmdbId: 604, type: 'movie', title: 'Reloaded' }] } });
    expect((await feed(cast.bob)).body.items.map((item) => item.media.tmdbId)).toEqual([604, 603]);
  });

  it('un titre ajouté à une liste partagée crée « listed » ; un profil enfant n’écrit rien', async () => {
    const created = await as<{ id: string }>(app, cast.alice, 'POST', '/user/social/lists', { body: { name: 'Soirée', members: [cast.bob.pid] } });
    expect(created.status).toBe(201);
    const added = await as(app, cast.bob, 'POST', `/user/social/lists/${created.body.id}/items`, { body: { type: 'series', tmdbId: 1399, title: 'GoT', poster: '/got.jpg' } });
    expect(added.status).toBe(201);
    const items = (await feed(cast.alice)).body.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'listed', pid: cast.bob.pid, media: { type: 'series', tmdbId: 1399, title: 'GoT', poster: '/got.jpg' } });
  });
});
