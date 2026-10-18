import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningApp, startApp } from './lt-harness.js';
import { bootstrapOwner, type Member } from './social-harness.js';
import { type ErrorBody, request, createProfileVia } from './user-harness.js';

interface HiddenPage {
  items: { key: string; title: string; poster: string; addedAt: number }[];
  total: number;
  nextCursor: string | null;
}

let app: RunningApp;
let alice: Member;

beforeEach(async () => {
  app = await startApp({});
  alice = await bootstrapOwner(app);
});

afterEach(async () => {
  await app.close();
});

const base = () => `/user/profiles/${alice.profile}/hidden`;
const entries = (from: number, count: number) =>
  Array.from({ length: count }, (_, k) => ({ key: `${k % 2 === 0 ? 'movie' : 'tv'}:${from + k}`, title: `Titre ${from + k}`, poster: `/p${from + k}.jpg`, addedAt: 1_700_000_000_000 + from + k }));
const hide = (items: unknown[]) => request<{ total: number } & ErrorBody>(app, 'PUT', base(), { token: alice.token, body: { entries: items } });
const page = (query = '') => request<HiddenPage>(app, 'GET', `${base()}${query}`, { token: alice.token });

describe('titres masqués (table par profil)', () => {
  it('masque, liste du plus récent au plus ancien, réaffiche', async () => {
    expect((await hide(entries(1, 3))).body.total).toBe(3);
    const res = await page();
    expect(res.body.total).toBe(3);
    expect(res.body.items.map((i) => i.key)).toEqual(['movie:3', 'tv:2', 'movie:1']);
    expect(res.body.nextCursor).toBeNull();
    expect((await request(app, 'DELETE', `${base()}/tv:2`, { token: alice.token })).status).toBe(204);
    const removed = await request<{ removed: number }>(app, 'POST', `${base()}/remove`, { token: alice.token, body: { keys: ['movie:1', 'movie:999'] } });
    expect(removed.body.removed).toBe(1);
    expect((await page()).body.items.map((i) => i.key)).toEqual(['movie:3']);
  });

  it('5000 entrées : écriture par lots de 500, lecture paginée complète sans doublon ni trou', async () => {
    for (let from = 1; from <= 5000; from += 500) expect((await hide(entries(from, 500))).status).toBe(200);
    const first = await page('?limit=500');
    expect(first.body.total).toBe(5000);
    const seen: string[] = [];
    let current = first;
    let calls = 0;
    for (;;) {
      seen.push(...current.body.items.map((item) => item.key));
      calls += 1;
      if (current.body.nextCursor === null) break;
      current = await page(`?limit=500&cursor=${encodeURIComponent(current.body.nextCursor)}`);
    }
    expect(calls).toBe(10);
    expect(seen).toHaveLength(5000);
    expect(new Set(seen).size).toBe(5000);
    // Ordre décroissant des dates d'ajout (id croissant = date croissante).
    expect(seen[0]).toBe('tv:5000');
    expect(seen[4999]).toBe('movie:1');
  }, 120_000);

  it('recherche par titre (sans casse, caractères spéciaux littéraux) et total filtré', async () => {
    await hide([
      { key: 'movie:1', title: 'Le Parrain', poster: '' },
      { key: 'movie:2', title: 'Parrain II', poster: '' },
      { key: 'tv:3', title: '100% Vrai_Faux', poster: '' },
      { key: 'tv:4', title: 'Autre', poster: '' },
    ]);
    expect((await page('?q=PARRAIN')).body.items).toHaveLength(2);
    expect((await page('?q=PARRAIN')).body.total).toBe(2);
    expect((await page('?q=' + encodeURIComponent('100%'))).body.items.map((i) => i.key)).toEqual(['tv:3']);
    expect((await page('?q=' + encodeURIComponent('_'))).body.items.map((i) => i.key)).toEqual(['tv:3']);
    expect((await page('?q=zzz')).body).toMatchObject({ items: [], total: 0 });
  });

  it('un titre déjà masqué garde sa date ; clés et lots invalides refusés', async () => {
    await hide([{ key: 'movie:7', title: 'Avant', poster: '', addedAt: 1000 }]);
    await hide([{ key: 'movie:7', title: 'Après', poster: '', addedAt: 9999 }]);
    expect((await page()).body.items).toEqual([{ key: 'movie:7', title: 'Après', poster: '', addedAt: 1000 }]);
    expect((await hide([{ key: 'person:7', title: 'x', poster: '' }])).status).toBe(400);
    expect((await hide([])).status).toBe(400);
    expect((await hide(entries(1, 501))).status).toBe(400);
    expect((await page('?limit=501')).status).toBe(400);
  });

  it('import automatique des anciens morceaux de réglages (homeHidden0..11) au premier accès, une seule fois', async () => {
    const chunk = (from: number) => entries(from, 40).map((e) => ({ key: e.key, title: e.title, poster: e.poster, addedAt: e.addedAt }));
    const put = await request(app, 'PUT', `/user/profiles/${alice.profile}/settings`, {
      token: alice.token,
      body: {
        homeGenres: [28, 12],
        homeHidden: 3,
        homeHidden0: chunk(1),
        homeHidden1: chunk(41),
        homeHidden2: [...chunk(81).slice(0, 5), { key: 'n-importe-quoi', title: 'x', poster: '', addedAt: 1 }, 42],
      },
    });
    expect(put.status).toBe(200);
    const res = await page('?limit=500');
    expect(res.body.total).toBe(85);
    expect(res.body.items.some((i) => i.key === 'movie:1')).toBe(true);
    // Les anciens morceaux sont supprimés des réglages (les autres réglages restent).
    const settings = await request<{ settings: Record<string, unknown> }>(app, 'GET', `/user/profiles/${alice.profile}/settings`, { token: alice.token });
    expect(Object.keys(settings.body.settings)).toEqual(['homeGenres']);
    // Un morceau réécrit plus tard n'est pas réimporté : la table fait foi.
    await request(app, 'PUT', `/user/profiles/${alice.profile}/settings`, { token: alice.token, body: { homeHidden0: chunk(500) } });
    expect((await page()).body.total).toBe(85);
  });

  it('l’import ne touche qu’au profil demandé ; un profil sans ancien morceau démarre vide', async () => {
    const other = await createProfileVia(app, alice.token, { name: 'autre' });
    await request(app, 'PUT', `/user/profiles/${alice.profile}/settings`, { token: alice.token, body: { homeHidden: 1, homeHidden0: entries(1, 3) } });
    expect((await request<HiddenPage>(app, 'GET', `/user/profiles/${other.body.id}/hidden`, { token: alice.token })).body.total).toBe(0);
    expect((await page()).body.total).toBe(3);
  });

  it('exige une session et un profil du compte', async () => {
    expect((await request(app, 'GET', base())).status).toBe(401);
    expect((await request(app, 'GET', '/user/profiles/inconnu/hidden', { token: alice.token })).status).toBe(404);
  });
});
