// Supprimer après visionnage (ODY-234) : un téléchargement terminé est retiré quand son titre (film ou épisode) est marqué vu,
// si le réglage est actif et hors profil enfant. Un téléchargement en cours ou en attente n'est jamais touché ; une erreur est
// avalée. Le gestionnaire est simulé ; l'interrupteur est testé sur le module réel de l'interface.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { onWatched, watchedPlan } from '../src/downloads/afterWatch';
import { getDeleteAfterWatch, setDeleteAfterWatch } from '../src/downloads/settings';

const h = vi.hoisted(() => ({
  kid: false,
  items: new Map<string, { id: string; state: string }>(),
  removed: [] as string[],
  fail: null as null | 'get' | 'remove',
}));

vi.mock('../src/data/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/auth')>()),
  isKidProfile: () => h.kid,
}));

vi.mock('../src/downloads/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/downloads/service')>()),
  getDownloads: async () => {
    if (h.fail === 'get') throw new Error('gestionnaire indisponible');
    return {
      get: (id: string) => h.items.get(id),
      remove: async (id: string) => {
        if (h.fail === 'remove') throw new Error('disque refusé');
        h.removed.push(id);
        h.items.delete(id);
      },
    };
  },
}));

const put = (id: string, state: string): void => {
  h.items.set(id, { id, state });
};

beforeEach(() => {
  localStorage.clear();
  h.kid = false;
  h.items.clear();
  h.removed = [];
  h.fail = null;
});

afterEach(() => {
  localStorage.clear();
});

describe('réglage « supprimer après visionnage »', () => {
  it('désactivé par défaut', () => {
    expect(getDeleteAfterWatch()).toBe(false);
  });

  it('persiste sous la clé laststream.downloads.deleteAfterWatch', () => {
    setDeleteAfterWatch(true);
    expect(getDeleteAfterWatch()).toBe(true);
    expect(localStorage.getItem('laststream.downloads.deleteAfterWatch')).toBe('1');
    setDeleteAfterWatch(false);
    expect(getDeleteAfterWatch()).toBe(false);
    expect(localStorage.getItem('laststream.downloads.deleteAfterWatch')).toBe('0');
  });
});

describe('onWatched', () => {
  it('réglage désactivé : rien n’est supprimé', async () => {
    put('tv:1399:1:2', 'done');
    put('movie:550', 'done');
    await onWatched('tv:1399', 1, 2);
    await onWatched('movie:550');
    expect(h.removed).toEqual([]);
    expect(h.items.has('tv:1399:1:2')).toBe(true);
    expect(h.items.has('movie:550')).toBe(true);
  });

  it('réglage actif : l’épisode terminé est retiré', async () => {
    setDeleteAfterWatch(true);
    put('tv:1399:1:2', 'done');
    await onWatched('tv:1399', 1, 2);
    expect(h.removed).toEqual(['tv:1399:1:2']);
    expect(h.items.has('tv:1399:1:2')).toBe(false);
  });

  it('réglage actif : le film terminé est retiré', async () => {
    setDeleteAfterWatch(true);
    put('movie:550', 'done');
    await onWatched('movie:550');
    expect(h.removed).toEqual(['movie:550']);
  });

  it('ne retire que l’épisode vu, pas les autres épisodes ni la série', async () => {
    setDeleteAfterWatch(true);
    put('tv:1399:1:2', 'done');
    put('tv:1399:1:3', 'done');
    put('tv:1399', 'done');
    await onWatched('tv:1399', 1, 2);
    expect(h.removed).toEqual(['tv:1399:1:2']);
    expect(h.items.has('tv:1399:1:3')).toBe(true);
    expect(h.items.has('tv:1399')).toBe(true);
  });

  it.each(['running', 'pending', 'paused', 'error'])('un téléchargement à l’état %s n’est jamais touché', async (state) => {
    setDeleteAfterWatch(true);
    put('movie:550', state);
    await onWatched('movie:550');
    expect(h.removed).toEqual([]);
    expect(h.items.has('movie:550')).toBe(true);
  });

  it('aucun téléchargement pour ce titre : rien à faire, sans erreur', async () => {
    setDeleteAfterWatch(true);
    await expect(onWatched('movie:550')).resolves.toBeUndefined();
    expect(h.removed).toEqual([]);
  });

  it('profil enfant : rien n’est supprimé même réglage actif', async () => {
    setDeleteAfterWatch(true);
    h.kid = true;
    put('movie:550', 'done');
    await onWatched('movie:550');
    expect(h.removed).toEqual([]);
    expect(h.items.has('movie:550')).toBe(true);
  });

  it('erreur du gestionnaire à l’obtention : avalée', async () => {
    setDeleteAfterWatch(true);
    h.fail = 'get';
    await expect(onWatched('movie:550')).resolves.toBeUndefined();
  });

  it('erreur à la suppression : avalée, le téléchargement reste', async () => {
    setDeleteAfterWatch(true);
    h.fail = 'remove';
    put('movie:550', 'done');
    await expect(onWatched('movie:550')).resolves.toBeUndefined();
    expect(h.items.has('movie:550')).toBe(true);
  });
});

describe('interrupteur de l’interface', () => {
  beforeAll(() => {
    const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
    document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  });

  it('basculer l’interrupteur écrit le réglage, dans les deux sens', async () => {
    const ui = await import('../src/ui/settings-downloads.js');
    ui.applyDownloadToggle('dl-after', true);
    expect(getDeleteAfterWatch()).toBe(true);
    expect(localStorage.getItem('laststream.downloads.deleteAfterWatch')).toBe('1');
    ui.applyDownloadToggle('dl-after', false);
    expect(getDeleteAfterWatch()).toBe(false);
    expect(localStorage.getItem('laststream.downloads.deleteAfterWatch')).toBe('0');
  });
});

describe('watchedPlan : fichier téléchargé en cours de lecture', () => {
  it('lecture d’un fichier téléchargé : la suppression est différée à la fermeture du lecteur', () => {
    expect(watchedPlan(true, 'tv:1399', 1, 2)).toEqual({ later: { key: 'tv:1399', season: 1, episode: 2 } });
  });

  it('streaming : suppression immédiate, rien de différé', () => {
    expect(watchedPlan(false, 'movie:550')).toEqual({ later: null });
  });

  it('le fichier n’est retiré qu’à la fermeture : différé puis onWatched appelé au teardown', async () => {
    setDeleteAfterWatch(true);
    put('tv:1399:1:2', 'done');
    const plan = watchedPlan(true, 'tv:1399', 1, 2);
    expect(h.removed).toEqual([]);
    await onWatched(plan.later!.key, plan.later!.season, plan.later!.episode);
    expect(h.removed).toEqual(['tv:1399:1:2']);
  });
});
