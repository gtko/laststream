// Feedback de l'app (LAST-1654) : empreinte des erreurs, contexte joint, envoi vers Sentry et vers le forum.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({
  active: true,
  exceptions: [] as { err: unknown; hint: Record<string, unknown> }[],
  feedbacks: [] as { params: Record<string, unknown>; hint: Record<string, unknown> }[],
}));
vi.mock('@sentry/browser', async (importOriginal) => {
  const real = await importOriginal<typeof import('@sentry/browser')>();
  return {
    ...real,
    getClient: () => (sentry.active ? {} : undefined),
    captureException: (err: unknown, hint: Record<string, unknown>) => {
      sentry.exceptions.push({ err, hint });
      return 'e'.repeat(32);
    },
    captureFeedback: (params: Record<string, unknown>, hint: Record<string, unknown>) => {
      sentry.feedbacks.push({ params, hint });
      return 'f'.repeat(32);
    },
  };
});
const forum = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[], fail: '' }));
vi.mock('../src/data/forumApi', () => ({
  sendForumFeedback: (input: Record<string, unknown>) => {
    forum.calls.push(input);
    if (forum.fail) return Promise.reject(Object.assign(new Error(forum.fail), { code: forum.fail }));
    return Promise.resolve({ topic: { id: 'T1' }, grouped: true, reporters: 3 });
  },
}));

const community = vi.hoisted(() => ({ on: true }));
vi.mock('../src/data/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/data/auth')>();
  return { ...real, hasCommunity: () => community.on };
});
const fb = await import('../src/data/feedback');

beforeEach(() => {
  sentry.active = true;
  sentry.exceptions = [];
  sentry.feedbacks = [];
  forum.calls = [];
  forum.fail = '';
  community.on = true;
});
afterEach(() => {
  fb.setFeedbackContext('lecteur', null);
});

describe('empreinte des erreurs', () => {
  it('écran, titre sans accents ni casse, statut HTTP s’il y en a un', () => {
    expect(fb.errorCode('player', 'Lecture impossible', 'La source ne répond plus (HTTP 503).')).toBe('player:lecture-impossible:http-503');
    expect(fb.errorCode('player', 'Lecture impossible', 'Source introuvable (404)')).toBe('player:lecture-impossible:http-404');
    expect(fb.errorCode('amis', 'Impossible de charger les amis.')).toBe('amis:impossible-de-charger-les-amis');
    expect(fb.slug('  Élan — Ça « marche » !  ')).toBe('elan-ca-marche');
  });

  it('noteError : dernière erreur, oubliée après 10 minutes', () => {
    const e = fb.noteError({ where: 'player', title: 'Lecture impossible', message: 'HTTP 503' });
    expect(e.code).toBe('player:lecture-impossible:http-503');
    expect(fb.recentError(e.at + 60_000)).toBe(e);
    expect(fb.recentError(e.at + 11 * 60_000)).toBeNull();
  });
});

describe('plateforme', () => {
  it('Windows, macOS et Linux dans la coque, Android, TV, navigateur', () => {
    expect(fb.platformOf('windows', 'Mozilla/5.0 (Windows NT 10.0)')).toBe('windows');
    expect(fb.platformOf('windows', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('macos');
    expect(fb.platformOf('windows', 'Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
    expect(fb.platformOf('android', 'Mozilla/5.0 (Linux; Android 14)')).toBe('android');
    expect(fb.platformOf('web', 'Mozilla/5.0 (Web0S; Linux/SmartTV)')).toBe('tv');
    expect(fb.platformOf('web', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130')).toBe('web');
  });
});

describe('contexte joint', () => {
  it('application, appareil et modules actifs ; texte filtré (aucun lien de flux)', () => {
    fb.setFeedbackContext('lecteur', () => ({ Titre: 'Les Gardiens du phare', Fichier: 'https://debrid.example/dl/abcdef/film.mkv', Vide: '' }));
    const ctx = fb.collectContext();
    expect(Object.keys(ctx)).toEqual(['application', 'appareil', 'lecteur']);
    expect(ctx.application).toMatchObject({ Profil: 'principal' });
    expect(ctx.lecteur.Titre).toBe('Les Gardiens du phare');
    expect(String(ctx.lecteur.Fichier)).not.toContain('debrid.example/dl');
    expect(ctx.lecteur).not.toHaveProperty('Vide');
  });

  it('un module qui échoue ne bloque pas le feedback', () => {
    fb.setFeedbackContext('lecteur', () => { throw new Error('boom'); });
    expect(Object.keys(fb.collectContext())).toEqual(['application', 'appareil']);
  });
});

describe('envoi', () => {
  it('bug depuis une erreur : exception à empreinte stable, retour rattaché, puis forum regroupé', async () => {
    const err = fb.noteError({ where: 'player', title: 'Lecture impossible', message: 'La source ne répond plus (HTTP 503).' });
    const res = await fb.sendFeedback({ kind: 'bug', message: 'Ça coupe au début', reason: 'Coupures', error: err, forum: true });
    expect(res).toEqual({ sentry: true, forum: { topicId: 'T1', grouped: true, reporters: 3 } });
    expect(sentry.exceptions).toHaveLength(1);
    expect(sentry.exceptions[0]?.hint).toMatchObject({ fingerprint: ['feedback', 'player:lecture-impossible:http-503'] });
    expect(sentry.feedbacks[0]?.params).toMatchObject({ message: 'Coupures. Ça coupe au début', associatedEventId: 'e'.repeat(32) });
    expect(forum.calls[0]).toMatchObject({
      kind: 'bug',
      code: 'player:lecture-impossible:http-503',
      title: 'Lecture impossible · HTTP 503',
      message: 'Coupures. Ça coupe au début',
      sentryEventId: 'f'.repeat(32),
    });
    expect(fb.recentError()).toBeNull(); // erreur signalée : plus jointe par défaut
  });

  it('idée : pas d’exception, forum sans empreinte ; « Autre » ne va jamais sur le forum', async () => {
    await fb.sendFeedback({ kind: 'idea', message: 'Trier par date', forum: true });
    expect(sentry.exceptions).toHaveLength(0);
    expect(forum.calls[0]).toMatchObject({ kind: 'idea', message: 'Trier par date' });
    expect(forum.calls[0]?.code).toBeUndefined();
    await fb.sendFeedback({ kind: 'other', message: 'Bravo', forum: true });
    expect(forum.calls).toHaveLength(1);
  });

  it('forum refusé : Sentry a reçu le feedback, le code est rendu', async () => {
    forum.fail = 'rate_limited';
    const res = await fb.sendFeedback({ kind: 'bug', message: 'x', forum: true });
    expect(res).toMatchObject({ sentry: true, forum: null, forumError: 'rate_limited' });
  });

  it('auto-hébergé sans Sentry : aucune destination, entrées masquées', async () => {
    sentry.active = false;
    community.on = false;
    expect(fb.feedbackAvailable()).toBe(false);
    await expect(fb.sendFeedback({ kind: 'bug', message: 'x', forum: true })).rejects.toThrow('feedback_unavailable');
  });

  it('sans Sentry mais sur le service en ligne : forum seulement ; échec du forum remonté', async () => {
    sentry.active = false;
    const ok = await fb.sendFeedback({ kind: 'bug', message: 'x', forum: true });
    expect(ok).toMatchObject({ sentry: false, forum: { topicId: 'T1' } });
    forum.fail = 'network';
    await expect(fb.sendFeedback({ kind: 'bug', message: 'x', forum: true })).rejects.toThrow();
  });
});
