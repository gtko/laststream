import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decryptJson } from '../src/config/codec.js';
import { MOLOTOV_API, MOLOTOV_HEADERS, MOLOTOV_UA } from '../src/user/molotov.js';
import { json, mockUpstream, SECRET, text, type MockUpstream } from './harness-core.js';
import { addKidProfile, request, startAdmin, type AdminRig } from './admin-harness.js';
import { createProfileVia, type ErrorBody } from './user-harness.js';

const asProfile = (profile: string) => ({ 'x-profile-id': profile });

const ID_TOKEN = 'jeton-molotov-id-token';
const REFRESH_TOKEN = 'jeton-molotov-refresh';
const NEW_ID_TOKEN = 'jeton-molotov-id-token-neuf';
const NEW_REFRESH_TOKEN = 'jeton-molotov-refresh-neuf';
const MFA_TOKEN = 'jeton-mfa';
const NEW_MFA_TOKEN = 'jeton-mfa-neuf';
const MFA_CODE = '123456';
const DRM_TOKEN = 'jeton-drm';
const CHALLENGE = Buffer.from('challenge-widevine-binaire', 'utf8');
const LICENSE_BYTES = new Uint8Array([0, 1, 2, 3, 250, 251, 252]);

const CATALOGUE = {
  pages: [
    {
      title: 'En direct',
      items: [
        { channel_id: 'ch-2', name: 'Canal B', logo: 'https://img.example/b.png' },
        {
          channel_id: 'ch-1',
          name: 'Canal A',
          callSign: 'CANAL-A',
          logoOnDarkUrl: 'https://img.example/a.png',
          group: 'Général',
          program: { title: 'Émission A' },
        },
        { channel_id: 'ch-3' },
        { name: 'Sans identifiant' },
      ],
    },
  ],
};

const ASSET = {
  stream: { url: 'https://cdn.example/master.mpd', packagingProtocol: 'dash', drmProtected: true },
  drm: { provider: 'irdeto', scheme: 'widevine', licenseUrl: `${MOLOTOV_API}/vapi/v1/drm/irdeto-proxy/license?drmId=x`, token: DRM_TOKEN },
  heartbeat: { method: 'POST', url: `${MOLOTOV_API}/vapi/heartbeat/v2?channelId=ch-1&id=LIVE_1&type=live`, payload: { passback: { a: 1 }, pdt: '@', progress: '@' } },
};

/**
 * Page PAPI du replay/VOD (`GET /papi/v1/page/replay-vod`) : rubriques et items avec `program`, `assets` et action
 * `on_play` — la forme n'est pas figée, l'extraction est défensive. Deux `on_play` volontairement différents :
 * un gabarit de lecture (`/vapi/v1/playback`) et l'URL de l'asset (`/vapi/asset/v1`).
 */
const REPLAY_PAGE = {
  content: { title: 'Replay & VOD' },
  components: [
    {
      title: 'Nouveautés',
      items: [
        {
          kind: 'series',
          program: { programId: 's-1', title: 'Série une', shortDescription: 'Sous-titre', horizontalImage: 'https://img.example/s1.jpg' },
          assets: [{ id: 'LIVE_100', type: 'vod' }],
          channel: { id: 'ch-1', name: 'Canal A' },
          actions: { on_play: { url: '/vapi/v1/playback?assetId=LIVE_100&type=resume' } },
        },
        {
          kind: 'program',
          program: { programId: 'p-2', title: 'Émission deux', horizontalImage: 'https://img.example/p2.jpg' },
          assets: [{ id: 'LIVE_200', type: 'vod' }],
          channelId: 'ch-2',
          actions: { on_play: { url: '/vapi/asset/v1?assetId=LIVE_200&type=vod' } },
        },
        // Ni programme ni asset : jamais une tuile.
        { title: 'Sans identifiant', assets: [] },
        // Asset seul : lecture directe, sans fiche.
        { kind: 'program', program: { title: 'Asset seul' }, assets: [{ id: 'LIVE_300', type: 'vod' }] },
        {
          kind: 'program',
          title: 'Documentaire seul',
          assets: [{ id: 'LIVE_400', type: 'vod' }],
          channelId: 'ch-4',
          actions: { on_play: { url: '/vapi/asset/v1?assetId=LIVE_400&type=scrub' } },
        },
      ],
    },
  ],
};

/** Fiche d'émission amont : programme, saisons et épisodes (`program` + `assets`), forme non figée. */
const PROGRAM_SHEET = {
  program: {
    programId: 's-1',
    title: 'Série une',
    tagline: 'La série',
    description: 'Une longue description.',
    horizontalImage: 'https://img.example/s1.jpg',
  },
  seasons: [
    {
      name: 'Saison 1',
      episodes: [
        {
          program: { programId: 'e-1', title: 'Épisode 1', shortDescription: 'S1E1', horizontalImage: 'https://img.example/e1.jpg' },
          assets: [{ id: 'LIVE_201', type: 'vod' }],
        },
        { program: { programId: 'e-2', title: 'Épisode 2' }, assets: [{ id: 'LIVE_202', type: 'vod' }] },
      ],
    },
  ],
};

/** Config de lecture d'un asset replay : même forme que l'asset du direct, l'identifiant suivant la requête. */
function replayAssetReply(search: URLSearchParams): Response {
  const assetId = search.get('assetId') ?? 'LIVE_1';
  if (assetId === 'absent') return json({ error: 'gone' }, 404);
  const type = search.get('type') ?? 'vod';
  return json({
    stream: { url: 'https://cdn.example/replay.mpd', packagingProtocol: 'dash', drmProtected: true },
    drm: { provider: 'irdeto', scheme: 'widevine', licenseUrl: `${MOLOTOV_API}/vapi/v1/drm/irdeto-proxy/license?drmId=x`, token: DRM_TOKEN },
    heartbeat: {
      method: 'POST',
      url: `${MOLOTOV_API}/vapi/heartbeat/v2?channelId=ch-9&id=${assetId}&type=${type}`,
      payload: { passback: { a: 2 }, pdt: '@', progress: '@' },
    },
  });
}

/** Horaires ISO du guide amont. */
const iso = (at: number) => new Date(at).toISOString();

/** Corps de `GET /epg` : chaînes et programmes, horaires dans `assets[].accessRights`. */
const epgDoc = (entries: Array<{ channel: Record<string, unknown>; programs: Record<string, unknown>[] }>) => ({
  paginationState: { hasNextPage: false },
  response: entries.map((entry) => ({ type: 'channelWithProgramAssets', data: { channel: entry.channel, programsWithAssets: entry.programs } })),
});

/** Instant de référence des tests du guide : chaque test avance l'horloge au-delà du cache (10 min). */
const EPG_BASE = Date.now();

/** Instant de référence des tests du replay : chaque test avance l'horloge au-delà de son cache (10 min). */
const REPLAY_BASE = Date.now();

interface StatusBody {
  connected: boolean;
  tier: string | null;
  userId: string | null;
  profileId: string | null;
  email: string | null;
  channelCount: number;
  updatedAt: number | null;
}

interface ChannelsBody {
  channels: Array<{ id: string; name: string; callSign: string | null; logo: string | null; group: string | null; live: boolean; program: string | null }>;
  fetchedAt: number;
  rawChannelCount: number;
}

interface PlayBody {
  channelId: string;
  manifestUrl: string;
  drm: { scheme: string | null; licenseUrl: string | null; licenseToken: string | null };
  heartbeatUrl: string | null;
  heartbeatPayload: Record<string, unknown> | null;
  assetId: string | null;
  expiresAt: number;
}

interface EpgBody {
  channels: Array<{
    id: string;
    name: string;
    logo: string | null;
    callSign: string | null;
    programs: Array<{ id: string; title: string; start: string; end: string; type: string | null; desc: string | null; image: string | null }>;
  }>;
  fetchedAt: number;
}

interface ReplayItemBody {
  id: string;
  title: string;
  subtitle: string | null;
  image: string | null;
  kind: string | null;
  assetId: string | null;
  channelId: string | null;
  programId: string | null;
  playUrl: string | null;
}

interface ReplayBody {
  items: ReplayItemBody[];
  fetchedAt: number;
}

interface ProgramBody {
  id: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  image: string | null;
  episodes: Array<{ id: string; title: string; subtitle: string | null; image: string | null; assetId: string | null }>;
}

describe('compte Molotov', () => {
  let rig: AdminRig;
  let upstream: MockUpstream;
  /** Corps binaires reçus par l'API (relais de licence). */
  let binaryBodies: Uint8Array[] = [];
  /** Nombre d'appels à `/papi/v1/config` : le premier renvoie 401 (session expirée). */
  let configCalls = 0;
  /** Réponse de `PUT /v2/signin`, pilotée par les tests (identifiants acceptés, refusés, ou vérification en deux étapes). */
  let signinReply: () => Response = () => json({ id_token: ID_TOKEN, refresh_token: REFRESH_TOKEN });
  /** Réponse de `PUT /mfa/verify`, pilotée par les tests (code accepté ou refusé). */
  let verifyReply: () => Response = () => json({ id_token: ID_TOKEN, refresh_token: REFRESH_TOKEN });
  /** Réponse de `PUT /mfa/email/resend`, pilotée par les tests (le jeton de défi peut changer). */
  let resendReply: () => Response = () => json({ payload: { token: NEW_MFA_TOKEN } });
  /** Réponse de `GET /epg`, pilotée par les tests (guide public, sans Authorization). */
  let epgReply: () => Response = () => json(epgDoc([]));
  /** Réponse de `GET /papi/v1/page/replay-vod`, pilotée par les tests (catalogue replay/VOD). */
  let replayReply: () => Response = () => json(REPLAY_PAGE);

  beforeAll(async () => {
    upstream = mockUpstream({
      [`${MOLOTOV_API}/profile`]: () => json({ userId: 'user-1', profileId: 'prof-1', email: 'alice@example.test' }),
      [`${MOLOTOV_API}/users/tier`]: () => json({ tier: 'premium' }),
      [`${MOLOTOV_API}/papi/v1/page/live-tv`]: () => json(CATALOGUE),
      [`${MOLOTOV_API}/papi/v1/main-navigation`]: () => json({ ok: true }),
      // Direct (channelId) : l'asset historique ; replay (assetId) : la config suit la demande.
      [`${MOLOTOV_API}/vapi/asset/v1`]: (call) => (call.url.searchParams.get('assetId') === null ? json(ASSET) : replayAssetReply(call.url.searchParams)),
      [`${MOLOTOV_API}/papi/v1/page/replay-vod`]: () => replayReply(),
      [`${MOLOTOV_API}/papi/v1/program-details/series/s-1`]: () => json(PROGRAM_SHEET),
      [`${MOLOTOV_API}/papi/v1/program-details/series/p-1`]: () => json({ error: 'gone' }, 404),
      [`${MOLOTOV_API}/papi/v1/program-details/program/p-1`]: () => json(PROGRAM_SHEET),
      [`${MOLOTOV_API}/papi/v1/program-details/series/absent`]: () => json({ error: 'gone' }, 404),
      [`${MOLOTOV_API}/papi/v1/program-details/program/absent`]: () => json({ error: 'gone' }, 404),
      [`${MOLOTOV_API}/vapi/heartbeat/v2`]: () => json({ ok: true }),
      [`${MOLOTOV_API}/vapi/v1/drm/irdeto-proxy/license`]: () => new Response(LICENSE_BYTES, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
      [`${MOLOTOV_API}/refresh`]: () => json({ id_token: NEW_ID_TOKEN, refresh_token: NEW_REFRESH_TOKEN }),
      [`${MOLOTOV_API}/oauth/google`]: () => json({ error: 'invalid_google_client' }, 400),
      [`${MOLOTOV_API}/v2/signin`]: () => signinReply(),
      [`${MOLOTOV_API}/mfa/verify`]: () => verifyReply(),
      [`${MOLOTOV_API}/mfa/email/resend`]: () => resendReply(),
      [`${MOLOTOV_API}/epg`]: () => epgReply(),
      [`${MOLOTOV_API}/papi/v1/config`]: () => {
        configCalls += 1;
        return configCalls === 1 ? json({ error: 'expired' }, 401) : json({ ok: true });
      },
    });
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.body instanceof Uint8Array) binaryBodies.push(new Uint8Array(init.body));
      return upstream.fetch(input, init);
    };
    rig = await startAdmin({ fetch: fetchImpl });
  });

  afterAll(async () => {
    await rig.app.close();
  });

  const connect = () =>
    request(rig.app, 'PUT', '/user/account/molotov', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { idToken: ID_TOKEN, refreshToken: REFRESH_TOKEN },
    });

  /** Ligne chiffrée du compte propriétaire, lue hors API. */
  const storedRow = async (): Promise<{ accountId: string; tokens: string; profile: string | null } | null> => {
    const accounts = await rig.backend.admin().listAccounts({ limit: 50 } as never);
    for (const account of accounts.accounts) {
      const row = await rig.backend.users().getMolotovAccount(account.id);
      if (row !== null) return { accountId: account.id, tokens: row.tokens, profile: row.profile };
    }
    return null;
  };

  it('sans session : 401 ; corps vide : 400 ; profil secondaire : 403', async () => {
    expect((await request(rig.app, 'GET', '/user/account/molotov')).status).toBe(401);
    expect((await request(rig.app, 'PUT', '/user/account/molotov', { body: {} })).status).toBe(401);
    const empty = await request<ErrorBody>(rig.app, 'PUT', '/user/account/molotov', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: {},
    });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe('invalid_body');
    const secondary = await createProfileVia(rig.app, rig.owner.token, { name: 'Second' });
    const kid = await addKidProfile(rig.app, rig.owner);
    for (const profile of [secondary.body.id, kid, undefined]) {
      const res = await request<ErrorBody>(rig.app, 'PUT', '/user/account/molotov', {
        token: rig.owner.token,
        headers: profile === undefined ? {} : asProfile(profile),
        body: { idToken: ID_TOKEN, refreshToken: REFRESH_TOKEN },
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('main_profile_required');
    }
  });

  it('connexion puis état du compte (jamais les jetons)', async () => {
    const put = await connect();
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ ok: true });
    const res = await request<StatusBody>(rig.app, 'GET', '/user/account/molotov', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body.connected).toBe(true);
    expect(res.body.email).toBe('alice@example.test');
    expect(res.body.tier).toBe('premium');
    expect(res.body.userId).toBe('user-1');
    expect(JSON.stringify(res.body)).not.toContain(ID_TOKEN);
  });

  it('credentials : jetons en clair pour l\'appel direct depuis l\'appareil', async () => {
    await connect();
    const res = await request<{ idToken: string; refreshToken: string; expiresAt: number | null }>(rig.app, 'GET', '/user/account/molotov/credentials', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body.idToken).toBe(ID_TOKEN);
    expect(res.body.refreshToken).toBe(REFRESH_TOKEN);
    const secondary = await request(rig.app, 'GET', '/user/account/molotov/credentials', { token: rig.owner.token });
    expect(secondary.status).toBe(403);
  });

  it('catalogue : extraction défensive des chaînes', async () => {
    await connect();
    const res = await request<ChannelsBody>(rig.app, 'GET', '/user/account/molotov/channels', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    expect(res.status).toBe(200);
    expect(res.body.channels.map((channel) => channel.id)).toEqual(['ch-1', 'ch-2']);
    expect(res.body.channels[0]?.name).toBe('Canal A');
    expect(res.body.channels[0]?.logo).toBe('https://img.example/a.png');
    expect(res.body.channels[0]?.callSign).toBe('CANAL-A');
    expect(res.body.channels[0]?.program).toBe('Émission A');
    expect(res.body.channels[0]?.live).toBe(true);
    expect(res.body.rawChannelCount).toBe(3);
    expect(res.body.fetchedAt).toBeGreaterThan(0);
  });

  it('guide TV : réponse compactée, programmes et horaires ISO', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(EPG_BASE);
    try {
      epgReply = () =>
        json(
          epgDoc([
            {
              channel: { id: '600046', name: 'TF1', displayName: 'TF1', logoOnDarkUrl: 'https://img.example/tf1.png', callSign: 'tf1' },
              programs: [
                {
                  program: {
                    programId: '6545672_46',
                    title: 'Journal',
                    type: 'episode',
                    shortDescription: 'x'.repeat(250),
                    horizontalImage: 'https://img.example/journal.jpg',
                  },
                  assets: [{ type: 'stream', accessRights: { startTime: iso(EPG_BASE - 600_000), endTime: iso(EPG_BASE + 600_000) } }],
                },
              ],
            },
          ]),
        );
      await connect();
      const res = await request<EpgBody>(rig.app, 'GET', '/user/account/molotov/epg', {
        token: rig.owner.token,
        headers: asProfile(rig.owner.profile),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.body.fetchedAt).toBe(EPG_BASE);
      expect(res.body.channels).toHaveLength(1);
      const channel = res.body.channels[0];
      expect(channel?.id).toBe('600046');
      expect(channel?.name).toBe('TF1');
      expect(channel?.logo).toBe('https://img.example/tf1.png');
      expect(channel?.callSign).toBe('tf1');
      expect(channel?.programs).toEqual([
        {
          id: '6545672_46',
          title: 'Journal',
          start: iso(EPG_BASE - 600_000),
          end: iso(EPG_BASE + 600_000),
          type: 'episode',
          desc: 'x'.repeat(200),
          image: 'https://img.example/journal.jpg',
        },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('guide TV : les programmes hors fenêtre ou sans horaire sont écartés, les autres triés', async () => {
    const now = EPG_BASE + 11 * 60_000;
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      epgReply = () =>
        json(
          epgDoc([
            {
              channel: { id: '600046', name: 'TF1', displayName: 'TF1' },
              programs: [
                // Terminé depuis deux heures : hors fenêtre.
                {
                  program: { programId: 'vieux', title: 'Vieux programme' },
                  assets: [{ type: 'stream', accessRights: { startTime: iso(now - 3 * 3600_000), endTime: iso(now - 2 * 3600_000) } }],
                },
                // Déclaré avant le courant mais commence après : la liste reste triée par horaire de début.
                {
                  program: { programId: 'suivant', title: 'Programme suivant' },
                  assets: [{ type: 'stream', accessRights: { startTime: iso(now + 600_000), endTime: iso(now + 1200_000) } }],
                },
                // Premier asset hors « stream » : les horaires viennent de l'asset stream.
                {
                  program: { programId: 'courant', title: 'Programme courant' },
                  assets: [
                    { type: 'vod', accessRights: { startTime: iso(now - 3 * 3600_000), endTime: iso(now - 2 * 3600_000) } },
                    { type: 'stream', accessRights: { startTime: iso(now - 600_000), endTime: iso(now + 600_000) } },
                  ],
                },
                // Dans plus de 24 h : hors fenêtre.
                {
                  program: { programId: 'lointain', title: 'Programme lointain' },
                  assets: [{ type: 'stream', accessRights: { startTime: iso(now + 25 * 3600_000), endTime: iso(now + 26 * 3600_000) } }],
                },
                // Sans horaire exploitable.
                { program: { programId: 'sans-horaire', title: 'Sans horaire' }, assets: [{ type: 'stream' }] },
              ],
            },
          ]),
        );
      const res = await request<EpgBody>(rig.app, 'GET', '/user/account/molotov/epg', {
        token: rig.owner.token,
        headers: asProfile(rig.owner.profile),
      });
      expect(res.status).toBe(200);
      const programs = res.body.channels[0]?.programs ?? [];
      expect(programs.map((p) => p.id)).toEqual(['courant', 'suivant']);
      expect(programs[0]?.start).toBe(iso(now - 600_000));
      expect(programs[0]?.end).toBe(iso(now + 600_000));
    } finally {
      spy.mockRestore();
    }
  });

  it("guide TV : deux appels ne font qu'un appel amont (cache dix minutes)", async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(EPG_BASE + 22 * 60_000);
    try {
      epgReply = () => json(epgDoc([{ channel: { id: '600046', name: 'TF1' }, programs: [] }]));
      const before = upstream.callsTo(`${MOLOTOV_API}/epg`).length;
      const first = await request<EpgBody>(rig.app, 'GET', '/user/account/molotov/epg', {
        token: rig.owner.token,
        headers: asProfile(rig.owner.profile),
      });
      const second = await request<EpgBody>(rig.app, 'GET', '/user/account/molotov/epg', {
        token: rig.owner.token,
        headers: asProfile(rig.owner.profile),
      });
      expect(upstream.callsTo(`${MOLOTOV_API}/epg`).length).toBe(before + 1);
      expect(second.body.channels).toEqual(first.body.channels);
      expect(second.body.fetchedAt).toBe(first.body.fetchedAt);
    } finally {
      spy.mockRestore();
    }
  });

  it("guide TV : l'appel amont ne porte pas de Authorization", async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(EPG_BASE + 33 * 60_000);
    try {
      epgReply = () => json(epgDoc([{ channel: { id: '600046', name: 'TF1' }, programs: [] }]));
      const res = await request(rig.app, 'GET', '/user/account/molotov/epg', {
        token: rig.owner.token,
        headers: asProfile(rig.owner.profile),
      });
      expect(res.status).toBe(200);
      const call = upstream.callsTo(`${MOLOTOV_API}/epg`).at(-1);
      expect(call?.headers['authorization']).toBeUndefined();
      expect(call?.headers['x-application-id']).toBe(MOLOTOV_HEADERS['x-application-id']);
      expect(call?.headers['user-agent']).toBe(MOLOTOV_UA);
      expect(call?.headers['origin']).toBe('https://app.molotov.tv');
    } finally {
      spy.mockRestore();
    }
  });

  it('guide TV : amont en panne ou corps illisible, 502 molotov_unavailable', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(EPG_BASE + 44 * 60_000);
    try {
      epgReply = () => json({ error: 'boom' }, 500);
      const down = await request<ErrorBody>(rig.app, 'GET', '/user/account/molotov/epg', {
        token: rig.owner.token,
        headers: asProfile(rig.owner.profile),
      });
      expect(down.status).toBe(502);
      expect(down.body.error).toBe('molotov_unavailable');
      epgReply = () => text('pas du json');
      const unreadable = await request<ErrorBody>(rig.app, 'GET', '/user/account/molotov/epg', {
        token: rig.owner.token,
        headers: asProfile(rig.owner.profile),
      });
      expect(unreadable.status).toBe(502);
      expect(unreadable.body.error).toBe('molotov_unavailable');
    } finally {
      spy.mockRestore();
    }
  });

  it('lecture : manifeste, DRM et battement de cœur', async () => {
    await connect();
    const res = await request<PlayBody>(rig.app, 'POST', '/user/account/molotov/play', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { channelId: 'ch-1' },
    });
    expect(res.status).toBe(200);
    expect(res.body.manifestUrl).toBe('https://cdn.example/master.mpd');
    expect(res.body.drm.scheme).toBe('widevine');
    expect(res.body.drm.licenseUrl).toBe(`${MOLOTOV_API}/vapi/v1/drm/irdeto-proxy/license?drmId=x`);
    expect(res.body.drm.licenseToken).toBe(DRM_TOKEN);
    expect(res.body.heartbeatUrl).toBe(`${MOLOTOV_API}/vapi/heartbeat/v2?channelId=ch-1&id=LIVE_1&type=live`);
    expect(res.body.expiresAt).toBeGreaterThan(Date.now());
    expect(res.body.channelId).toBe('ch-1');
    expect(res.body.assetId).toBe('LIVE_1');
  });

  it('heartbeat : progression relayée vers l\'API', async () => {
    await connect();
    const res = await request(rig.app, 'POST', '/user/account/molotov/heartbeat', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { channelId: 'ch-1', assetId: 'LIVE_1', progress: 12345 },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const call = upstream.callsTo(`${MOLOTOV_API}/vapi/heartbeat/v2`).at(-1);
    expect(call?.url.searchParams.get('channelId')).toBe('ch-1');
    expect(call?.url.searchParams.get('id')).toBe('LIVE_1');
    expect(call?.url.searchParams.get('type')).toBe('live');
    const sent = JSON.parse(call?.body ?? '{}') as { passback: unknown; pdt: number; progress: number };
    expect(sent.progress).toBe(12345);
    expect(typeof sent.pdt).toBe('number');
  });

  it('heartbeat : la charge utile amont n\'est pas ré-encapsulée', async () => {
    await connect();
    await request(rig.app, 'POST', '/user/account/molotov/heartbeat', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { channelId: 'ch-1', progress: 42, payload: { passback: { a: 1 }, pdt: '@', progress: '@' } },
    });
    const call = upstream.callsTo(`${MOLOTOV_API}/vapi/heartbeat/v2`).at(-1);
    const sent = JSON.parse(call?.body ?? '{}') as { passback: { a: number }; pdt: number; progress: number };
    expect(sent.passback).toEqual({ a: 1 });
    expect(sent.progress).toBe(42);
    expect(typeof sent.pdt).toBe('number');
  });

  it('heartbeat : un assetId absent n\'est pas envoyé comme « undefined »', async () => {
    await connect();
    await request(rig.app, 'POST', '/user/account/molotov/heartbeat', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { channelId: 'ch-1', progress: 7 },
    });
    const call = upstream.callsTo(`${MOLOTOV_API}/vapi/heartbeat/v2`).at(-1);
    expect(call?.url.searchParams.has('id')).toBe(false);
  });

  it('le relais exige le profil principal', async () => {
    await connect();
    const kid = await addKidProfile(rig.app, rig.owner);
    const res = await request<ErrorBody>(rig.app, 'GET', '/user/account/molotov/relay?path=/papi/v1/config', {
      token: rig.owner.token,
      headers: asProfile(kid),
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('main_profile_required');
  });

  it('un client Google refusé par l\'API est remonté tel quel', async () => {
    const res = await request<ErrorBody>(rig.app, 'PUT', '/user/account/molotov', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { googleToken: 'jeton-google' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('google_token_rejected');
  });

  it('connexion par email/mot de passe : session enregistrée, profil amont récupéré', async () => {
    signinReply = () => json({ type: 'SUCCESS', payload: { id_token: ID_TOKEN, refresh_token: REFRESH_TOKEN } });
    const res = await request<StatusBody>(rig.app, 'POST', '/user/account/molotov/signin', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { email: 'alice@example.test', password: 'mot-de-passe' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body.connected).toBe(true);
    expect(res.body.email).toBe('alice@example.test');
    expect(res.body.tier).toBe('premium');
    expect(res.body.userId).toBe('user-1');
    expect(res.body.updatedAt).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain(ID_TOKEN);
    const signin = upstream.callsTo(`${MOLOTOV_API}/v2/signin`).at(-1);
    expect(signin?.method).toBe('PUT');
    expect(JSON.parse(signin?.body ?? '{}')).toEqual({ username: 'alice@example.test', password: 'mot-de-passe' });
    expect(signin?.headers['content-type']).toBe('application/json');
    expect(signin?.headers['x-application-id']).toBe(MOLOTOV_HEADERS['x-application-id']);
    expect(signin?.headers['origin']).toBe('https://app.molotov.tv');
    expect(signin?.headers['authorization']).toBeUndefined();
    const profile = upstream.callsTo(`${MOLOTOV_API}/profile`).at(-1);
    expect(profile?.headers['authorization']).toBe(`Bearer ${ID_TOKEN}`);
  });

  it('identifiants invalides : 401 invalid_credentials, aucune ligne de compte', async () => {
    await request(rig.app, 'DELETE', '/user/account/molotov', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    signinReply = () => json({ code: 'INVALID_USERNAME_PASSWORD' }, 401);
    const res = await request<ErrorBody>(rig.app, 'POST', '/user/account/molotov/signin', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { email: 'alice@example.test', password: 'faux' },
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
    expect(await storedRow()).toBeNull();
  });

  it('limite de débit amont : 429 rate_limited', async () => {
    signinReply = () => json({ code: 'CHILL_PLZ' }, 429);
    const res = await request<ErrorBody>(rig.app, 'POST', '/user/account/molotov/signin', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { email: 'alice@example.test', password: 'mot-de-passe' },
    });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
  });

  it('repli : les jetons en camelCase restent acceptés', async () => {
    await request(rig.app, 'DELETE', '/user/account/molotov', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    signinReply = () => json({ idToken: ID_TOKEN, refreshToken: REFRESH_TOKEN });
    const res = await request(rig.app, 'POST', '/user/account/molotov/signin', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { email: 'alice@example.test', password: 'mot-de-passe' },
    });
    expect(res.status).toBe(200);
    expect((await storedRow()) !== null).toBe(true);
  });

  it('connexion avec vérification en deux étapes : 200 mfa_required, jeton de défi, aucune ligne de compte', async () => {
    await request(rig.app, 'DELETE', '/user/account/molotov', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    signinReply = () => json({ type: 'MFA', payload: { token: MFA_TOKEN } });
    const res = await request<{ status: string; mfaToken: string }>(rig.app, 'POST', '/user/account/molotov/signin', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { email: 'alice@example.test', password: 'mot-de-passe' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toEqual({ status: 'mfa_required', mfaToken: MFA_TOKEN });
    expect(await storedRow()).toBeNull();
    const signin = upstream.callsTo(`${MOLOTOV_API}/v2/signin`).at(-1);
    expect(signin?.method).toBe('PUT');
    expect(JSON.parse(signin?.body ?? '{}')).toEqual({ username: 'alice@example.test', password: 'mot-de-passe' });
    expect(signin?.headers['x-application-id']).toBe(MOLOTOV_HEADERS['x-application-id']);
    expect(signin?.headers['origin']).toBe('https://app.molotov.tv');
    expect(signin?.headers['authorization']).toBeUndefined();
  });

  it('vérification du code : 200 connecté, jetons chiffrés au repos', async () => {
    verifyReply = () => json({ payload: { id_token: ID_TOKEN, refresh_token: REFRESH_TOKEN } });
    const res = await request<StatusBody>(rig.app, 'POST', '/user/account/molotov/signin/verify', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { mfaToken: MFA_TOKEN, code: MFA_CODE },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body.connected).toBe(true);
    expect(res.body.email).toBe('alice@example.test');
    expect(res.body.tier).toBe('premium');
    expect(JSON.stringify(res.body)).not.toContain(ID_TOKEN);
    const verify = upstream.callsTo(`${MOLOTOV_API}/mfa/verify`).at(-1);
    expect(verify?.method).toBe('PUT');
    expect(JSON.parse(verify?.body ?? '{}')).toEqual({ code: MFA_CODE });
    expect(verify?.headers['x-mfa-token']).toBe(MFA_TOKEN);
    expect(verify?.headers['x-application-id']).toBe(MOLOTOV_HEADERS['x-application-id']);
    expect(verify?.headers['authorization']).toBeUndefined();
    const row = await storedRow();
    expect(row).not.toBeNull();
    expect(row?.tokens).not.toContain(ID_TOKEN);
    expect(row?.tokens).not.toContain(REFRESH_TOKEN);
    const plain = decryptJson(row?.tokens ?? '', SECRET, `molotov:${row?.accountId}`) as { idToken: string; refreshToken: string };
    expect(plain.idToken).toBe(ID_TOKEN);
    expect(plain.refreshToken).toBe(REFRESH_TOKEN);
  });

  it('code refusé par l\'API (4xx) : 401 invalid_code, aucune ligne de compte', async () => {
    await request(rig.app, 'DELETE', '/user/account/molotov', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    verifyReply = () => json({ code: 'INVALID_CODE' }, 401);
    const res = await request<ErrorBody>(rig.app, 'POST', '/user/account/molotov/signin/verify', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { mfaToken: MFA_TOKEN, code: '000000' },
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_code');
    expect(JSON.stringify(res.body)).not.toContain(MFA_TOKEN);
    expect(await storedRow()).toBeNull();
  });

  it('trop d\'essais (CHILL_PLZ) : 429 rate_limited', async () => {
    verifyReply = () => json({ code: 'CHILL_PLZ' }, 429);
    const res = await request<ErrorBody>(rig.app, 'POST', '/user/account/molotov/signin/verify', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { mfaToken: MFA_TOKEN, code: MFA_CODE },
    });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
  });

  it('renvoi du code : 200 avec le jeton renvoyé (changement ou conservation)', async () => {
    resendReply = () => json({ payload: { token: NEW_MFA_TOKEN } });
    const res = await request<{ mfaToken: string }>(rig.app, 'POST', '/user/account/molotov/signin/resend', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { mfaToken: MFA_TOKEN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toEqual({ mfaToken: NEW_MFA_TOKEN });
    const call = upstream.callsTo(`${MOLOTOV_API}/mfa/email/resend`).at(-1);
    expect(call?.method).toBe('PUT');
    expect(call?.body).toBe('');
    expect(call?.headers['x-mfa-token']).toBe(MFA_TOKEN);
    expect(call?.headers['authorization']).toBeUndefined();
    resendReply = () => json({ ok: true });
    const kept = await request<{ mfaToken: string }>(rig.app, 'POST', '/user/account/molotov/signin/resend', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { mfaToken: NEW_MFA_TOKEN },
    });
    expect(kept.status).toBe(200);
    expect(kept.body).toEqual({ mfaToken: NEW_MFA_TOKEN });
  });

  it('relais : chemin hors liste refusé, URL absolue refusée, en-têtes x-* et Authorization relayés', async () => {
    await connect();
    const unknown = await request<ErrorBody>(rig.app, 'GET', '/user/account/molotov/relay?path=/admin/users', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('unsupported_path');
    const absolute = await request<ErrorBody>(rig.app, 'GET', '/user/account/molotov/relay?path=/papi/v1/config&query=url=https://evil.example/x', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    expect(absolute.status).toBe(400);
    expect(absolute.body.error).toBe('invalid_body');
    const ok = await request<{ ok: boolean }>(rig.app, 'GET', '/user/account/molotov/relay?path=/papi/v1/main-navigation&query=a=1', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    const call = upstream.callsTo(`${MOLOTOV_API}/papi/v1/main-navigation`).at(-1);
    expect(call?.headers['x-application-id']).toBe(MOLOTOV_HEADERS['x-application-id']);
    expect(call?.headers['x-client-version']).toBe(MOLOTOV_HEADERS['x-client-version']);
    expect(call?.headers['x-drm-scheme']).toBe('widevine');
    expect(call?.headers['origin']).toBe('https://app.molotov.tv');
    expect(call?.headers['user-agent']).toBe(MOLOTOV_UA);
    expect(call?.headers['authorization']).toBe(`Bearer ${ID_TOKEN}`);
    expect(call?.url.searchParams.get('a')).toBe('1');
    expect((await request(rig.app, 'GET', '/user/account/molotov/relay?path=/papi/v1/main-navigation')).status).toBe(401);
  });

  it('relais licence : octets bruts, hôte imposé', async () => {
    await connect();
    binaryBodies = [];
    const res = await fetch(`${rig.app.baseUrl}/user/account/molotov/license`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${rig.owner.token}`,
        'x-profile-id': rig.owner.profile,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        licenseUrl: `${MOLOTOV_API}/vapi/v1/drm/irdeto-proxy/license?drmId=x&ls_session=abc`,
        token: DRM_TOKEN,
        challenge: CHALLENGE.toString('base64'),
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(LICENSE_BYTES);
    expect(binaryBodies[0]).toEqual(new Uint8Array(CHALLENGE));
    const call = upstream.callsTo(`${MOLOTOV_API}/vapi/v1/drm/irdeto-proxy/license`).at(-1);
    expect(call?.headers['authorization']).toBe(`Bearer ${DRM_TOKEN}`);
    expect(call?.headers['content-type']).toBe('application/octet-stream');
    const refused = await request<ErrorBody>(rig.app, 'POST', '/user/account/molotov/license', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: {
        licenseUrl: 'https://irdeto.fubo.tv/licenseServer/widevine/v1/FuboTV/license',
        token: DRM_TOKEN,
        challenge: CHALLENGE.toString('base64'),
      },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('invalid_body');
  });

  it('chiffrement au repos : les jetons stockés sont opaques et se rejouent', async () => {
    await connect();
    const row = await storedRow();
    expect(row).not.toBeNull();
    expect(row?.tokens).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(row?.tokens).not.toContain(ID_TOKEN);
    expect(row?.tokens).not.toContain(REFRESH_TOKEN);
    const plain = decryptJson(row?.tokens ?? '', SECRET, `molotov:${row?.accountId}`) as { idToken: string; refreshToken: string };
    expect(plain.idToken).toBe(ID_TOKEN);
    expect(plain.refreshToken).toBe(REFRESH_TOKEN);
    expect(row?.profile).not.toBeNull();
    expect(row?.profile).not.toContain('alice@example.test');
  });

  it('401 amont : rafraîchissement puis rejeu, jetons réécrits', async () => {
    await connect();
    configCalls = 0;
    const res = await request<{ ok: boolean }>(rig.app, 'GET', '/user/account/molotov/relay?path=/papi/v1/config', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const refresh = upstream.callsTo(`${MOLOTOV_API}/refresh`).at(-1);
    expect(refresh?.headers['authorization']).toBe(`Bearer ${REFRESH_TOKEN}`);
    const row = await storedRow();
    const plain = decryptJson(row?.tokens ?? '', SECRET, `molotov:${row?.accountId}`) as { idToken: string; refreshToken: string };
    expect(plain.idToken).toBe(NEW_ID_TOKEN);
    expect(plain.refreshToken).toBe(NEW_REFRESH_TOKEN);
  });

  it('relais désactivé (LASTADDON_MOLOTOV_RELAY=0) : 403 relay_disabled', async () => {
    await connect();
    vi.stubEnv('LASTADDON_MOLOTOV_RELAY', '0');
    try {
      for (const [method, path] of [
        ['GET', '/user/account/molotov/relay?path=/papi/v1/config'],
        ['GET', '/user/account/molotov/channels'],
        ['GET', '/user/account/molotov/replay'],
        ['GET', '/user/account/molotov/program?id=s-1'],
        ['POST', '/user/account/molotov/play'],
        ['POST', '/user/account/molotov/play-asset'],
        ['POST', '/user/account/molotov/heartbeat'],
        ['POST', '/user/account/molotov/license'],
      ] as const) {
        const res = await request<ErrorBody>(rig.app, method, path, {
          token: rig.owner.token,
          headers: asProfile(rig.owner.profile),
          body: method === 'POST' ? { channelId: 'ch-1', assetId: 'LIVE_1', progress: 1 } : undefined,
        });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('relay_disabled');
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('déconnexion : la ligne disparaît et l\'état repasse à non connecté', async () => {
    await connect();
    const res = await request(rig.app, 'DELETE', '/user/account/molotov', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const status = await request<StatusBody>(rig.app, 'GET', '/user/account/molotov', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    expect(status.body.connected).toBe(false);
    expect(status.body.updatedAt).toBeNull();
  });

  it('replay : extraction défensive des tuiles (ordre du document, identifiants programme ou asset)', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(REPLAY_BASE);
    try {
      replayReply = () => json(REPLAY_PAGE);
      await connect();
      const res = await request<ReplayBody>(rig.app, 'GET', '/user/account/molotov/replay', {
        token: rig.owner.token,
        headers: asProfile(rig.owner.profile),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.body.fetchedAt).toBe(REPLAY_BASE);
      expect(res.body.items).toEqual([
        {
          id: 's-1',
          title: 'Série une',
          subtitle: 'Sous-titre',
          image: 'https://img.example/s1.jpg',
          kind: 'series',
          assetId: 'LIVE_100',
          channelId: 'ch-1',
          programId: 's-1',
          // L'`on_play` de la page est un gabarit de lecture : sans config de lecture, l'appel asset sera construit.
          playUrl: null,
        },
        {
          id: 'p-2',
          title: 'Émission deux',
          subtitle: null,
          image: 'https://img.example/p2.jpg',
          kind: 'program',
          assetId: 'LIVE_200',
          channelId: 'ch-2',
          programId: 'p-2',
          playUrl: `${MOLOTOV_API}/vapi/asset/v1?assetId=LIVE_200&type=vod`,
        },
        {
          id: 'LIVE_300',
          title: 'Asset seul',
          subtitle: null,
          image: null,
          kind: 'program',
          assetId: 'LIVE_300',
          channelId: null,
          programId: null,
          playUrl: null,
        },
        {
          id: 'LIVE_400',
          title: 'Documentaire seul',
          subtitle: null,
          image: null,
          kind: 'program',
          assetId: 'LIVE_400',
          channelId: 'ch-4',
          programId: null,
          playUrl: `${MOLOTOV_API}/vapi/asset/v1?assetId=LIVE_400&type=scrub`,
        },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("replay : deux appels ne font qu'un appel amont (cache dix minutes)", async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(REPLAY_BASE + 11 * 60_000);
    try {
      replayReply = () => json(REPLAY_PAGE);
      await connect();
      const before = upstream.callsTo(`${MOLOTOV_API}/papi/v1/page/replay-vod`).length;
      const first = await request<ReplayBody>(rig.app, 'GET', '/user/account/molotov/replay', {
        token: rig.owner.token,
        headers: asProfile(rig.owner.profile),
      });
      const second = await request<ReplayBody>(rig.app, 'GET', '/user/account/molotov/replay', {
        token: rig.owner.token,
        headers: asProfile(rig.owner.profile),
      });
      expect(upstream.callsTo(`${MOLOTOV_API}/papi/v1/page/replay-vod`).length).toBe(before + 1);
      expect(second.body.items).toEqual(first.body.items);
      expect(second.body.fetchedAt).toBe(first.body.fetchedAt);
    } finally {
      spy.mockRestore();
    }
  });

  it('replay : forme réelle des cartes PAPI (title.text, body.main_button, footer)', async () => {
    // 21 min plus tard : hors du cache de 10 min, l'amont de ce test est bien appelé.
    const spy = vi.spyOn(Date, 'now').mockReturnValue(REPLAY_BASE + 21 * 60_000);
    try {
      replayReply = () => json({
        title: { text: 'Replay & VOD' },
        id: 'replay-vod',
        content: {
          template: 'grid',
          sections: [{
            type: 'grid',
            slug: 'replay-vod-grid',
            components: [
              {
                type: 'card-wide',
                id: 'replay-card-1',
                channel_id: '600046',
                title: { text: 'Tracker' },
                subtitle: { text: 'S3 E5' },
                body: {
                  picture: { url: 'https://img.example/t.jpg', type: 'picture' },
                  station_logo: { url: 'https://img.example/logo.png', type: 'picture' },
                  main_button: { actions: { on_play: [{ endpoint: { method: 'GET', url: `${MOLOTOV_API}/vapi/v1/playback?assetId=LIVE_200&type=vod` }, type: 'play' }] } },
                },
                footer: { actions: { on_click: [{ endpoint: { method: 'GET', url: `${MOLOTOV_API}/papi/v1/program-details/series/100007238` }, type: 'open' }] } },
              },
              // Entrée de navigation sans programme ni lecture : écartée.
              { type: 'chip-filter', id: 'chip-1', title: { text: 'Tout' } },
            ],
          }],
        },
      });
      await connect();
      const res = await request<ReplayBody>(rig.app, 'GET', '/user/account/molotov/replay', {
        token: rig.owner.token,
        headers: asProfile(rig.owner.profile),
      });
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([
        {
          id: '100007238',
          title: 'Tracker',
          subtitle: 'S3 E5',
          image: 'https://img.example/t.jpg',
          kind: null,
          assetId: 'LIVE_200',
          channelId: '600046',
          programId: '100007238',
          playUrl: null,
        },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('replay : amont en panne, 502 molotov_unavailable', async () => {
    // 33 min après la base : hors du cache de 10 min des tests précédents.
    const spy = vi.spyOn(Date, 'now').mockReturnValue(REPLAY_BASE + 33 * 60_000);
    try {
      replayReply = () => json({ error: 'boom' }, 500);
      const res = await request<ErrorBody>(rig.app, 'GET', '/user/account/molotov/replay', {
        token: rig.owner.token,
        headers: asProfile(rig.owner.profile),
      });
      expect(res.status).toBe(502);
      expect(res.body.error).toBe('molotov_unavailable');
    } finally {
      spy.mockRestore();
    }
  });

  it('program : fiche compactée (description, épisodes) sur le gabarit series', async () => {
    await connect();
    const res = await request<ProgramBody>(rig.app, 'GET', '/user/account/molotov/program?id=s-1&kind=series', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toEqual({
      id: 's-1',
      title: 'Série une',
      subtitle: 'La série',
      description: 'Une longue description.',
      image: 'https://img.example/s1.jpg',
      episodes: [
        { id: 'e-1', title: 'Épisode 1', subtitle: 'S1E1', image: 'https://img.example/e1.jpg', assetId: 'LIVE_201' },
        { id: 'e-2', title: 'Épisode 2', subtitle: null, image: null, assetId: 'LIVE_202' },
      ],
    });
    const call = upstream.callsTo(`${MOLOTOV_API}/papi/v1/program-details/series/s-1`).at(-1);
    expect(call?.headers['authorization']).toBe(`Bearer ${ID_TOKEN}`);
    expect(call?.headers['x-application-id']).toBe(MOLOTOV_HEADERS['x-application-id']);
  });

  it('program : 404 sur series bascule sur program, identifiant hors allow-list refusé, absent en 404', async () => {
    await connect();
    // `p-1` : le gabarit `series` répond 404, le gabarit `program` livre la fiche (chemins de la seule liste autorisée).
    const fallback = await request<ProgramBody>(rig.app, 'GET', '/user/account/molotov/program?id=p-1', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    expect(fallback.status).toBe(200);
    expect(fallback.body.id).toBe('s-1');
    expect(upstream.callsTo(`${MOLOTOV_API}/papi/v1/program-details/series/p-1`).length).toBeGreaterThan(0);
    expect(upstream.callsTo(`${MOLOTOV_API}/papi/v1/program-details/program/p-1`).length).toBeGreaterThan(0);
    // Identifiant ou gabarit hors liste : aucun chemin amont n'est construit.
    for (const path of [
      '/user/account/molotov/program?id=../profile',
      '/user/account/molotov/program?id=s-1/../../user',
      '/user/account/molotov/program?id=s-1&kind=movie',
    ]) {
      const refused = await request<ErrorBody>(rig.app, 'GET', path, {
        token: rig.owner.token,
        headers: asProfile(rig.owner.profile),
      });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('invalid_body');
    }
    // Absent des deux gabarits : l'élément n'existe pas.
    const missing = await request<ErrorBody>(rig.app, 'GET', '/user/account/molotov/program?id=absent', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('not_found');
  });

  it('play-asset : URL amont construite (assetId, type) et même corps que la lecture du direct', async () => {
    await connect();
    const res = await request<PlayBody>(rig.app, 'POST', '/user/account/molotov/play-asset', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { assetId: 'LIVE_200' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const call = upstream.callsTo(`${MOLOTOV_API}/vapi/asset/v1`).at(-1);
    expect(call?.url.searchParams.get('assetId')).toBe('LIVE_200');
    expect(call?.url.searchParams.get('type')).toBe('vod');
    expect(res.body.manifestUrl).toBe('https://cdn.example/replay.mpd');
    expect(res.body.drm.licenseToken).toBe(DRM_TOKEN);
    expect(res.body.heartbeatUrl).toBe(`${MOLOTOV_API}/vapi/heartbeat/v2?channelId=ch-9&id=LIVE_200&type=vod`);
    expect(res.body.assetId).toBe('LIVE_200');
    expect(res.body.channelId).toBe('ch-9');
    expect(res.body.expiresAt).toBeGreaterThan(Date.now());
    // Le type de lecture est repris tel quel (reprise, redémarrage, navigation).
    const scrub = await request<PlayBody>(rig.app, 'POST', '/user/account/molotov/play-asset', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { assetId: 'LIVE_200', type: 'scrub' },
    });
    expect(scrub.status).toBe(200);
    expect(upstream.callsTo(`${MOLOTOV_API}/vapi/asset/v1`).at(-1)?.url.searchParams.get('type')).toBe('scrub');
  });

  it('play-asset : la fournie en playUrl est utilisée telle quelle (allow-listée)', async () => {
    await connect();
    const playUrl = `${MOLOTOV_API}/vapi/asset/v1?assetId=LIVE_400&type=scrub`;
    const res = await request<PlayBody>(rig.app, 'POST', '/user/account/molotov/play-asset', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { assetId: 'LIVE_400', playUrl },
    });
    expect(res.status).toBe(200);
    const call = upstream.callsTo(`${MOLOTOV_API}/vapi/asset/v1`).at(-1);
    expect(call?.url.pathname + '?' + call?.url.searchParams.toString()).toBe('/vapi/asset/v1?assetId=LIVE_400&type=scrub');
    expect(res.body.assetId).toBe('LIVE_400');
    // Un asset absent de l'amont : 404 not_found.
    const missing = await request<ErrorBody>(rig.app, 'POST', '/user/account/molotov/play-asset', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { assetId: 'absent' },
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('not_found');
  });

  it('play-asset : playUrl hors allow-list refusé (400 invalid_body)', async () => {
    await connect();
    for (const playUrl of [
      'https://evil.example/vapi/asset/v1?assetId=LIVE_400',
      `${MOLOTOV_API}/v2/signin`,
      'file:///etc/passwd',
    ]) {
      const refused = await request<ErrorBody>(rig.app, 'POST', '/user/account/molotov/play-asset', {
        token: rig.owner.token,
        headers: asProfile(rig.owner.profile),
        body: { assetId: 'LIVE_400', playUrl },
      });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('invalid_body');
    }
    // Type de lecture hors liste : refusé aussi.
    const badType = await request<ErrorBody>(rig.app, 'POST', '/user/account/molotov/play-asset', {
      token: rig.owner.token,
      headers: asProfile(rig.owner.profile),
      body: { assetId: 'LIVE_400', type: 'live' },
    });
    expect(badType.status).toBe(400);
    expect(badType.body.error).toBe('invalid_body');
  });
});
