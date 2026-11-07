import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapOwner } from './social-harness.js';
import { type RunningApp, startApp } from './lt-harness.js';
import { as, befriend, castOf, type Cast, HOOK_TIMEOUT_MS, type Persona, personaOf } from './social-v2-harness.js';
import { type AccountBody, PASSWORD, request } from './user-harness.js';

/** Partage à des amis (POST /share), liens publics (POST /share-links, GET public) et invitation jointe (contrat S3b). */

interface MessageBody {
  messages: { id: string; conv: string; from: string; to?: string; kind: string; body: string; title?: Record<string, unknown>; moment?: Record<string, unknown> }[];
}

interface ListBody {
  messages: { body: string }[];
}

interface LinkCreated {
  url: string;
  code: string;
  inviteCode?: string;
}

interface PublicLink {
  type: string;
  tmdbId: number;
  title: string;
  poster?: string;
  pos?: number;
  end?: number;
  from: { handle: { name: string; tag: string; full: string }; avatarColor: string };
  note?: string;
  inviteCode?: string;
}

interface InviteList {
  quota: number;
  invites: { code: string; state: string; invitee: string | null }[];
}

let app: RunningApp;

beforeEach(async () => {
  app = await startApp({});
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  await app.close();
});

const MATRIX = { type: 'movie', tmdbId: 603, title: 'Matrix', poster: '/matrix.jpg' };

describe('partage à des amis', () => {
  let cast: Cast;

  beforeEach(async () => {
    cast = await castOf(app);
    await befriend(app, cast.alice, cast.bob);
  }, HOOK_TIMEOUT_MS);

  it('un titre partagé part en un message par ami, avec son contenu structuré', async () => {
    await befriend(app, cast.alice, cast.carol);
    const res = await as<MessageBody>(app, cast.alice, 'POST', '/user/social/share', {
      body: { to: [{ pid: cast.bob.pid }, { pid: cast.carol.pid }], kind: 'title', title: { ...MATRIX, rating: 4.5 }, body: ' à voir ' },
    });
    expect(res.status).toBe(201);
    expect(res.body.messages).toHaveLength(2);
    const bobMessage = res.body.messages.find((message) => message.to === cast.bob.pid);
    expect(bobMessage?.from).toBe(cast.alice.pid);
    expect(bobMessage?.body).toBe('à voir');
    expect(bobMessage?.kind).toBe('title');
    expect(bobMessage?.conv).toBe(`dm:${cast.bob.pid}`);
    expect(bobMessage?.title).toEqual({ type: 'movie', tmdbId: 603, title: 'Matrix', poster: '/matrix.jpg', rating: 4.5 });

    // Le texte du message est lisible côté destinataire (route v2 existante).
    const inbox = await as<ListBody>(app, cast.bob, 'GET', `/user/social/messages/${cast.alice.pid}`);
    expect(inbox.body.messages.map((message) => message.body)).toEqual(['à voir']);
  });

  it('un moment partagé garde sa position ; sans texte, le titre sert de repli', async () => {
    const res = await as<MessageBody>(app, cast.alice, 'POST', '/user/social/share', {
      body: {
        to: [{ pid: cast.bob.pid }],
        kind: 'moment',
        moment: { type: 'series', tmdbId: 1399, season: 1, episode: 2, title: 'Game of Thrones', pos: 754.5, still: '/still.jpg' },
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.messages[0]?.body).toBe('Game of Thrones');
    expect(res.body.messages[0]?.kind).toBe('moment');
    expect(res.body.messages[0]?.moment).toEqual({
      type: 'series',
      tmdbId: 1399,
      season: 1,
      episode: 2,
      title: 'Game of Thrones',
      pos: 754.5,
      still: '/still.jpg',
    });
  });

  it('un extrait partagé porte sa fin : pos et end dans le message, puis dans la boîte du destinataire', async () => {
    const res = await as<MessageBody>(app, cast.alice, 'POST', '/user/social/share', {
      body: {
        to: [{ pid: cast.bob.pid }],
        kind: 'moment',
        moment: { type: 'series', tmdbId: 1399, season: 1, episode: 2, title: 'Game of Thrones', pos: 754, end: 790 },
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.messages[0]?.moment).toMatchObject({ pos: 754, end: 790 });

    const inbox = await as<MessageBody>(app, cast.bob, 'GET', `/user/social/messages/${cast.alice.pid}`);
    expect(inbox.body.messages[0]?.moment).toMatchObject({ pos: 754, end: 790 });
  });

  it('un extrait doit finir après sa position et durer 300 s au plus (1 s au moins)', async () => {
    const share = (end: number) =>
      as<{ error: string; issues?: string[] }>(app, cast.alice, 'POST', '/user/social/share', {
        body: { to: [{ pid: cast.bob.pid }], kind: 'moment', moment: { type: 'movie', tmdbId: 603, title: 'Matrix', pos: 100, end } },
      });
    expect((await share(100)).status).toBe(400);
    expect((await share(99)).status).toBe(400);
    const tooLong = await share(401);
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.issues).toEqual(['moment.end:custom']);
    expect((await share(101)).status).toBe(201);
    expect((await share(400)).status).toBe(201);
  });

  it('un moment sans fin ne porte pas de clé end', async () => {
    const res = await as<MessageBody>(app, cast.alice, 'POST', '/user/social/share', {
      body: { to: [{ pid: cast.bob.pid }], kind: 'moment', moment: { type: 'movie', tmdbId: 603, title: 'Matrix', pos: 100 } },
    });
    expect(res.status).toBe(201);
    expect(res.body.messages[0]?.moment).not.toHaveProperty('end');
  });

  it('un non-ami est refusé et rien n’est envoyé ; soi-même est refusé', async () => {
    const refused = await as<{ error: string }>(app, cast.alice, 'POST', '/user/social/share', {
      body: { to: [{ pid: cast.bob.pid }, { pid: cast.carol.pid }], kind: 'title', title: MATRIX },
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('not_friend');
    const inbox = await as<ListBody>(app, cast.bob, 'GET', `/user/social/messages/${cast.alice.pid}`);
    expect(inbox.body.messages).toHaveLength(0);

    const self = await as<{ error: string }>(app, cast.alice, 'POST', '/user/social/share', {
      body: { to: [{ pid: cast.alice.pid }], kind: 'title', title: MATRIX },
    });
    expect(self.status).toBe(400);
    expect(self.body.error).toBe('self');
  });

  it('un groupe inconnu ou dont je ne suis pas membre : 404 conv_not_found, rien n’est envoyé', async () => {
    const res = await as<{ error: string }>(app, cast.alice, 'POST', '/user/social/share', {
      body: { to: [{ pid: cast.bob.pid }, { group: '11111111-2222-3333-4444-555555555555' }], kind: 'title', title: MATRIX },
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('conv_not_found');
    const inbox = await as<ListBody>(app, cast.bob, 'GET', `/user/social/messages/${cast.alice.pid}`);
    expect(inbox.body.messages).toHaveLength(0);

    const malformed = await as<{ error: string }>(app, cast.alice, 'POST', '/user/social/share', {
      body: { to: [{ group: 'inexistant' }], kind: 'title', title: MATRIX },
    });
    expect(malformed.status).toBe(400);
  });

  it('kind et contenu doivent concorder', async () => {
    const noTitle = await as<{ error: string; issues?: string[] }>(app, cast.alice, 'POST', '/user/social/share', {
      body: { to: [{ pid: cast.bob.pid }], kind: 'title' },
    });
    expect(noTitle.status).toBe(400);
    expect(noTitle.body.issues).toEqual(['title:required']);

    const noMoment = await as<{ error: string; issues?: string[] }>(app, cast.alice, 'POST', '/user/social/share', {
      body: { to: [{ pid: cast.bob.pid }], kind: 'moment', title: MATRIX },
    });
    expect(noMoment.status).toBe(400);
    expect(noMoment.body.issues).toEqual(['moment:required']);
  });

  it('quota de 30 messages par minute, chaque destinataire compte', async () => {
    for (let n = 0; n < 30; n += 1) {
      const sent = await as(app, cast.alice, 'POST', '/user/social/share', { body: { to: [{ pid: cast.bob.pid }], kind: 'title', title: MATRIX } });
      expect(sent.status).toBe(201);
    }
    const refused = await as<{ error: string }>(app, cast.alice, 'POST', '/user/social/share', { body: { to: [{ pid: cast.bob.pid }], kind: 'title', title: MATRIX } });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe('rate_limited');
  });
});

describe('liens publics', () => {
  let cast: Cast;
  let owner: Persona;

  beforeEach(async () => {
    cast = await castOf(app);
    owner = cast.alice;
  }, HOOK_TIMEOUT_MS);

  it('lecture sans session : titre, affiche, note et auteur (handle seul), sans pid ni bibliothèque', async () => {
    const created = await as<LinkCreated>(app, owner, 'POST', '/user/social/share-links', {
      body: { ...MATRIX, withInvite: false, note: 'Vu hier' },
    });
    expect(created.status).toBe(201);
    expect(created.body.url.endsWith(`/t/${created.body.code}`)).toBe(true);
    expect(created.body.code.length).toBeGreaterThanOrEqual(10);
    expect(created.body).not.toHaveProperty('inviteCode');

    const res = await request<PublicLink>(app, 'GET', `/user/social/share-links/${created.body.code}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['from', 'note', 'poster', 'title', 'tmdbId', 'type']);
    expect(res.body).toMatchObject({ type: 'movie', tmdbId: 603, title: 'Matrix', poster: '/matrix.jpg', note: 'Vu hier' });
    expect(res.body.from.handle.full).toBe(owner.full);
    expect(res.body.from).not.toHaveProperty('pid');
    expect(JSON.stringify(res.body)).not.toContain(owner.pid);
  });

  it('une position n’est publiée que pour un moment', async () => {
    const title = await as<LinkCreated>(app, owner, 'POST', '/user/social/share-links', { body: { ...MATRIX, withInvite: false } });
    const titleView = await request<PublicLink>(app, 'GET', `/user/social/share-links/${title.body.code}`);
    expect(titleView.body).not.toHaveProperty('pos');

    const moment = await as<LinkCreated>(app, owner, 'POST', '/user/social/share-links', { body: { ...MATRIX, pos: 1234, withInvite: false } });
    const momentView = await request<PublicLink>(app, 'GET', `/user/social/share-links/${moment.body.code}`);
    expect(momentView.body.pos).toBe(1234);
  });

  it('un extrait publie sa fin, dans la vue publique et dans mes liens', async () => {
    const created = await as<LinkCreated>(app, owner, 'POST', '/user/social/share-links', { body: { ...MATRIX, pos: 1234, end: 1290, withInvite: false } });
    expect(created.status).toBe(201);

    const view = await request<PublicLink>(app, 'GET', `/user/social/share-links/${created.body.code}`);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ pos: 1234, end: 1290 });

    const mine = await as<{ links: (PublicLink & { code: string })[] }>(app, owner, 'GET', '/user/social/share-links');
    expect(mine.status).toBe(200);
    expect(mine.body.links.find((link) => link.code === created.body.code)).toMatchObject({ pos: 1234, end: 1290 });
  });

  it('une fin exige une position et un extrait de 1 s à 5 min ; un lien sans fin n’a pas de clé end', async () => {
    const withoutPos = await as<{ error: string; issues?: string[] }>(app, owner, 'POST', '/user/social/share-links', {
      body: { ...MATRIX, end: 1290, withInvite: false },
    });
    expect(withoutPos.status).toBe(400);
    expect(withoutPos.body.issues).toEqual(['end:custom']);

    for (const end of [1234, 1200]) {
      const res = await as<{ issues?: string[] }>(app, owner, 'POST', '/user/social/share-links', { body: { ...MATRIX, pos: 1234, end, withInvite: false } });
      expect(res.status).toBe(400);
      expect(res.body.issues).toEqual(['end:custom']);
    }
    const tooLong = await as<{ issues?: string[] }>(app, owner, 'POST', '/user/social/share-links', {
      body: { ...MATRIX, pos: 1000, end: 1301, withInvite: false },
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.issues).toEqual(['end:custom']);

    const plain = await as<LinkCreated>(app, owner, 'POST', '/user/social/share-links', { body: { ...MATRIX, pos: 1000, withInvite: false } });
    expect(plain.status).toBe(201);
    const view = await request<PublicLink>(app, 'GET', `/user/social/share-links/${plain.body.code}`);
    expect(view.body).toMatchObject({ pos: 1000 });
    expect(view.body).not.toHaveProperty('end');
    const mine = await as<{ links: (PublicLink & { code: string })[] }>(app, owner, 'GET', '/user/social/share-links');
    expect(mine.body.links.find((link) => link.code === plain.body.code)).not.toHaveProperty('end');
  });

  it('le titre vient de l’index des fiches quand le corps n’en donne pas', async () => {
    const res = await as<{ error: string }>(app, owner, 'POST', '/user/social/share-links', { body: { type: 'movie', tmdbId: 999999, withInvite: false } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('title_required');
  });

  it('code inconnu ou mal formé : 404 share_not_found', async () => {
    const unknown = await request<{ error: string }>(app, 'GET', '/user/social/share-links/abcdefghijklmnop');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('share_not_found');
    const malformed = await request<{ error: string }>(app, 'GET', '/user/social/share-links/court');
    expect(malformed.status).toBe(404);
  });

  it('lecture publique limitée par adresse IP : 60 par minute', async () => {
    for (let n = 0; n < 60; n += 1) {
      const res = await request(app, 'GET', '/user/social/share-links/abcdefghijklmnop');
      expect(res.status).toBe(404);
    }
    const limited = await request<{ error: string }>(app, 'GET', '/user/social/share-links/abcdefghijklmnop');
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('rate_limited');
  });

  it('/t/:code sert l’index de l’application (repli de navigation)', async () => {
    const shell = await startApp({
      extra: {
        ui: {
          serve: async (_request: Request, pathname: string) =>
            pathname === '/index.html' ? new Response('<!doctype html><title>Laststream</title>APP-SHELL', { headers: { 'content-type': 'text/html; charset=utf-8' } }) : null,
        },
      },
    });
    try {
      const res = await fetch(`${shell.baseUrl}/t/abcdefghijklmnop`, { headers: { accept: 'text/html' } });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('APP-SHELL');
    } finally {
      await shell.close();
    }
  });
});

describe('invitation jointe à un lien', () => {
  let owner: Persona;
  let ownerMember: { token: string; profile: string };

  beforeEach(async () => {
    const member = await bootstrapOwner(app, 'owner');
    ownerMember = member;
    owner = await personaOf(app, member.token, member.profile, 'owner');
  }, HOOK_TIMEOUT_MS);

  it('le quota d’invitations borne les liens qui en portent une', async () => {
    const quota = await request(app, 'PUT', '/user/accounts/owner/invite-quota', { token: ownerMember.token, body: { quota: 1 } });
    expect(quota.status).toBe(200);

    const first = await as<LinkCreated>(app, owner, 'POST', '/user/social/share-links', { body: { ...MATRIX, withInvite: true } });
    expect(first.status).toBe(201);
    expect(first.body.inviteCode).toBeTypeOf('string');

    const second = await as<{ error: string }>(app, owner, 'POST', '/user/social/share-links', { body: { ...MATRIX, withInvite: true } });
    expect(second.status).toBe(429);
    expect(second.body.error).toBe('invite_quota_reached');

    // Un lien sans invitation ne consomme pas le quota.
    const plain = await as<LinkCreated>(app, owner, 'POST', '/user/social/share-links', { body: { ...MATRIX, withInvite: false } });
    expect(plain.status).toBe(201);
  });

  it('l’invitation est réservée à la création et consommée seulement à l’inscription via le code du lien', async () => {
    await request(app, 'PUT', '/user/accounts/owner/invite-quota', { token: ownerMember.token, body: { quota: 2 } });
    const created = await as<LinkCreated>(app, owner, 'POST', '/user/social/share-links', { body: { ...MATRIX, withInvite: true } });
    const inviteCode = created.body.inviteCode ?? '';

    // Réservée : état « envoyé », pas encore utilisée.
    const before = await request<InviteList>(app, 'GET', '/user/invites', { token: ownerMember.token });
    expect(before.body.invites.find((invite) => invite.code === inviteCode)).toMatchObject({ state: 'sent', invitee: null });
    const view = await request<PublicLink>(app, 'GET', `/user/social/share-links/${created.body.code}`);
    expect(view.body.inviteCode).toBe(inviteCode);

    // Inscription avec le code du lien : le filleul devient ami de l'auteur, l'invitation est consommée.
    const registered = await request<AccountBody>(app, 'POST', '/user/register', { body: { username: 'dave', password: PASSWORD, invite: inviteCode } });
    expect(registered.status).toBe(201);
    const after = await request<InviteList>(app, 'GET', '/user/invites', { token: ownerMember.token });
    expect(after.body.invites.find((invite) => invite.code === inviteCode)).toMatchObject({ state: 'used', invitee: 'dave' });
    const consumed = await request<PublicLink>(app, 'GET', `/user/social/share-links/${created.body.code}`);
    expect(consumed.body).not.toHaveProperty('inviteCode');
  });
});
