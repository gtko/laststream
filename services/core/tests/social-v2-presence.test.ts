import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocialEvent } from '../src/user/social-v2-events.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, type Acting, befriend, type Cast, castOf, type ErrorBodyV2, HOOK_TIMEOUT_MS, type MeBody } from './social-v2-harness.js';

interface ViewBody {
  pid: string;
  household: boolean;
  status: string;
  watching?: { type: string; title: string; season?: number; episode?: number; pos: number; paused: boolean; at: number };
  lastSeen?: number;
}
interface FriendsBody {
  friends: ViewBody[];
  household: ViewBody[];
}

interface Emitted {
  pids: string[];
  event: SocialEvent;
}

const NOW = '2026-05-01T10:00:00.000Z';
const START = Date.parse(NOW);

/** Événements émis pendant le test (gestionnaire injecté dans l'application). */
const emitted: Emitted[] = [];

let app: RunningApp;
let cast: Cast;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
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

const beat = (who: Acting, watching?: unknown) =>
  as<ErrorBodyV2>(app, who, 'PUT', '/user/social/presence', { body: watching === undefined ? {} : { watching } });
const watchingNow = (over: Record<string, unknown> = {}) => ({
  type: 'series',
  tmdbId: 1399,
  title: 'Game of Thrones',
  season: 2,
  episode: 4,
  pos: 754,
  duration: 3600,
  paused: false,
  at: Date.now(),
  ...over,
});
const viewOfFriend = async (viewer: Acting, pid: string): Promise<ViewBody | undefined> => {
  const res = await as<FriendsBody>(app, viewer, 'GET', '/user/social/friends');
  return res.body.friends.find((f) => f.pid === pid);
};

describe('présence vue par les amis', () => {
  it('un battement rend le profil en ligne, avec le titre en cours', async () => {
    expect((await beat(cast.bob, watchingNow())).status).toBe(204);
    const bob = await viewOfFriend(cast.alice, cast.bob.pid);
    expect(bob?.status).toBe('online');
    expect(bob?.household).toBe(false);
    expect(bob?.watching?.title).toBe('Game of Thrones');
    expect(bob?.watching?.season).toBe(2);
    expect(bob?.watching?.episode).toBe(4);
    expect(bob?.lastSeen).toBe(START);
  });

  it('sans battement pendant plus de 90 s : hors ligne, titre masqué ; un nouveau battement remet en ligne', async () => {
    await beat(cast.bob, watchingNow());
    vi.setSystemTime(START + 90_000);
    expect((await viewOfFriend(cast.alice, cast.bob.pid))?.status).toBe('online');
    vi.setSystemTime(START + 90_001);
    const stale = await viewOfFriend(cast.alice, cast.bob.pid);
    expect(stale?.status).toBe('offline');
    expect(stale?.watching).toBeUndefined();
    expect(stale?.lastSeen).toBe(START);
    await beat(cast.bob);
    expect((await viewOfFriend(cast.alice, cast.bob.pid))?.status).toBe('online');
  });

  it('mode invisible : vu hors ligne, sans titre ni dernier battement ; le statut choisi reste invisible', async () => {
    await as(app, cast.bob, 'PUT', '/user/social/status', { body: { status: 'invisible' } });
    await beat(cast.bob, watchingNow());
    const bob = await viewOfFriend(cast.alice, cast.bob.pid);
    expect(bob?.status).toBe('offline');
    expect(bob?.watching).toBeUndefined();
    expect(bob?.lastSeen).toBeUndefined();
    expect((await as<MeBody>(app, cast.bob, 'GET', '/user/social/me')).body.status).toBe('invisible');
  });

  it('statut choisi visible (absent, occupé, ne pas déranger) ; déconnexion : hors ligne immédiatement, statut conservé', async () => {
    await as(app, cast.bob, 'PUT', '/user/social/status', { body: { status: 'away' } });
    await beat(cast.bob);
    expect((await viewOfFriend(cast.alice, cast.bob.pid))?.status).toBe('away');
    expect((await as(app, cast.bob, 'DELETE', '/user/social/presence')).status).toBe(204);
    expect((await viewOfFriend(cast.alice, cast.bob.pid))?.status).toBe('offline');
    expect((await as<MeBody>(app, cast.bob, 'GET', '/user/social/me')).body.status).toBe('away');
    // Un profil jamais vu n’est pas en ligne tant qu’il n’a pas envoyé de battement.
    expect((await viewOfFriend(cast.bob, cast.alice.pid))?.status).toBe('offline');
  });

  it('corps : titre de film sans saison, null efface le titre, champs inconnus ou invalides refusés', async () => {
    const movie = await beat(cast.bob, { type: 'movie', tmdbId: 438631, title: 'Dune', season: 1, pos: 10, paused: true, at: Date.now() });
    expect(movie.status).toBe(204);
    const bob = await viewOfFriend(cast.alice, cast.bob.pid);
    expect(bob?.watching?.title).toBe('Dune');
    expect(bob?.watching?.season).toBeUndefined();
    expect(bob?.watching?.paused).toBe(true);
    expect((await beat(cast.bob, null)).status).toBe(204);
    expect((await viewOfFriend(cast.alice, cast.bob.pid))?.watching).toBeUndefined();

    expect((await beat(cast.bob, { type: 'movie', title: 'Sans identifiant', pos: 1, paused: false, at: 1 })).body.error).toBe('invalid_body');
    expect((await beat(cast.bob, watchingNow({ extra: 'x' }))).body.error).toBe('invalid_body');
    expect((await beat(cast.bob, watchingNow({ pos: -1 }))).body.error).toBe('invalid_body');
    expect((await beat(cast.bob, watchingNow({ imdbId: 'pas-un-imdb' }))).body.error).toBe('invalid_body');
    const extraKey = await as<ErrorBodyV2>(app, cast.bob, 'PUT', '/user/social/presence', { body: { status: 'dnd' } });
    expect(extraKey.body.error).toBe('invalid_body');
  });

  it('les profils enfants ne peuvent pas annoncer de présence (403)', async () => {
    expect((await beat(cast.kid, watchingNow())).status).toBe(403);
  });
});

describe('lecture figée : plus « en train de regarder » après 10 minutes', () => {
  const IDLE = 10 * 60_000;
  /** Battements toutes les 25 s jusqu'à `until` (ms après START), position et pause donnés. */
  const beatsUntil = async (until: number, over: Record<string, unknown>): Promise<void> => {
    for (let t = Date.now() - START + 25_000; t <= until; t += 25_000) {
      vi.setSystemTime(START + t);
      await beat(cast.bob, watchingNow(over));
    }
  };

  it('pause prolongée : titre retiré à plus de 10 min, l’ami reste en ligne ; la reprise le fait revenir', async () => {
    await beat(cast.bob, watchingNow({ paused: true }));
    await beatsUntil(IDLE, { paused: true });
    const edge = await viewOfFriend(cast.alice, cast.bob.pid);
    expect(edge?.status).toBe('online');
    expect(edge?.watching?.title).toBe('Game of Thrones');
    vi.setSystemTime(START + IDLE + 1);
    await beat(cast.bob, watchingNow({ paused: true }));
    const idle = await viewOfFriend(cast.alice, cast.bob.pid);
    expect(idle?.status).toBe('online');
    expect(idle?.watching).toBeUndefined();
    await beat(cast.bob, watchingNow({ paused: false }));
    expect((await viewOfFriend(cast.alice, cast.bob.pid))?.watching?.title).toBe('Game of Thrones');
  });

  it('lecture figée (même position sans pause) : retirée aussi ; une position qui avance réarme le délai', async () => {
    await beat(cast.bob, watchingNow());
    await beatsUntil(IDLE - 25_000, {});
    await beat(cast.bob, watchingNow({ pos: 9000 }));
    await beatsUntil(2 * IDLE - 25_000, { pos: 9000 });
    expect((await viewOfFriend(cast.alice, cast.bob.pid))?.watching?.title).toBe('Game of Thrones');
    await beatsUntil(2 * IDLE + 60_000, { pos: 9000 });
    expect((await viewOfFriend(cast.alice, cast.bob.pid))?.watching).toBeUndefined();
  });

  it('un saut de position ou un autre épisode réarme le délai', async () => {
    await beat(cast.bob, watchingNow({ paused: true }));
    await beatsUntil(IDLE - 25_000, { paused: true });
    await beat(cast.bob, watchingNow({ paused: true, pos: 1 }));
    vi.setSystemTime(START + IDLE + 60_000);
    expect((await viewOfFriend(cast.alice, cast.bob.pid))?.watching?.pos).toBe(1);
    await beat(cast.bob, watchingNow({ paused: true, pos: 1, episode: 5 }));
    await beatsUntil(IDLE + 60_000 + IDLE, { paused: true, pos: 1, episode: 5 });
    expect((await viewOfFriend(cast.alice, cast.bob.pid))?.watching?.episode).toBe(5);
  });

  it('événements : le retrait est annoncé une fois, les battements figés suivants ne sont pas rediffusés, la reprise l’est', async () => {
    await beat(cast.bob, watchingNow({ paused: true }));
    await beatsUntil(IDLE, { paused: true });
    emitted.length = 0;
    vi.setSystemTime(START + IDLE + 1);
    await beat(cast.bob, watchingNow({ paused: true }));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.event).toMatchObject({ t: 'presence', friend: { pid: cast.bob.pid, status: 'online' } });
    expect((emitted[0]?.event as { friend: ViewBody }).friend.watching).toBeUndefined();
    vi.setSystemTime(START + IDLE + 26_000);
    await beat(cast.bob, watchingNow({ paused: true }));
    expect(emitted).toHaveLength(1);
    await beat(cast.bob, watchingNow({ paused: false }));
    expect(emitted).toHaveLength(2);
    expect((emitted[1]?.event as { friend: ViewBody }).friend.watching?.title).toBe('Game of Thrones');
  });
});

describe('événements temps réel (gestionnaire injecté)', () => {
  it('présence : un événement par changement visible, aucun pour un battement identique', async () => {
    const fixed = watchingNow({ at: START });
    await beat(cast.bob, fixed);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.pids).toEqual([cast.alice.pid]);
    expect(emitted[0]?.event).toMatchObject({ t: 'presence', friend: { pid: cast.bob.pid, household: false, status: 'online' } });
    await beat(cast.bob, fixed);
    expect(emitted).toHaveLength(1);
    await beat(cast.bob, watchingNow({ at: START, pos: 800 }));
    expect(emitted).toHaveLength(2);
    await as(app, cast.bob, 'PUT', '/user/social/status', { body: { status: 'dnd' } });
    expect(emitted).toHaveLength(3);
    expect(emitted[2]?.event).toMatchObject({ t: 'presence', friend: { status: 'dnd' } });
  });

  it('présence du foyer : le second profil du compte est notifié avec household vrai', async () => {
    await beat(cast.alice2, watchingNow({ at: START }));
    const toHousehold = emitted.find((e) => e.pids.includes(cast.alice.pid));
    expect(toHousehold?.event).toMatchObject({ t: 'presence', friend: { pid: cast.alice2.pid, household: true } });
  });

  it('demande, acceptation et suppression : requête, deux vues d’amis, puis départ', async () => {
    await as(app, cast.alice, 'POST', '/user/social/requests', { body: { handle: cast.carol.full } });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.pids).toEqual([cast.carol.pid]);
    expect(emitted[0]?.event).toMatchObject({ t: 'request', request: { pid: cast.alice.pid, handle: { name: 'alice' } } });

    emitted.length = 0;
    await as(app, cast.carol, 'POST', `/user/social/requests/${cast.alice.pid}/accept`);
    expect(emitted.map((e) => e.pids)).toEqual([[cast.alice.pid], [cast.carol.pid]]);
    expect(emitted[0]?.event).toMatchObject({ t: 'friend', friend: { pid: cast.carol.pid, household: false } });
    expect(emitted[1]?.event).toMatchObject({ t: 'friend', friend: { pid: cast.alice.pid, household: false } });

    emitted.length = 0;
    await as(app, cast.alice, 'DELETE', `/user/social/friends/${cast.carol.pid}`);
    expect(emitted.map((e) => e.event)).toEqual([
      { t: 'unfriend', pid: cast.alice.pid },
      { t: 'unfriend', pid: cast.carol.pid },
    ]);
    expect(emitted.map((e) => e.pids)).toEqual([[cast.carol.pid], [cast.alice.pid]]);
  });

  it('un gestionnaire qui lève une exception n’interrompt jamais la requête', async () => {
    const broken = await startApp({
      extra: {
        socialEvents: () => {
          throw new Error('live indisponible');
        },
      },
    });
    try {
      const brokenCast = await castOf(broken);
      const sent = await as(broken, brokenCast.alice, 'POST', '/user/social/requests', { body: { handle: brokenCast.bob.full } });
      expect(sent.status).toBe(201);
      expect((await as(broken, brokenCast.bob, 'PUT', '/user/social/presence', { body: { watching: watchingNow() } })).status).toBe(204);
    } finally {
      await broken.close();
    }
  });
});
