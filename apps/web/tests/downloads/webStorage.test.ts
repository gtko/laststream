import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateStorage, requestPersistence, type StorageManagerLike } from '../../src/downloads/webStorage';

afterEach(() => {
  vi.unstubAllGlobals();
});

const UNKNOWN = { usage: null, quota: null, available: null, persisted: null };

describe('estimateStorage : quota et usage', () => {
  it('espace disponible = quota - usage, persistance lue', async () => {
    const storage: StorageManagerLike = {
      estimate: async () => ({ usage: 100, quota: 1000 }),
      persisted: async () => true,
    };
    expect(await estimateStorage(storage)).toEqual({ usage: 100, quota: 1000, available: 900, persisted: true });
  });

  it('usage supérieur au quota : espace disponible à zéro, jamais négatif', async () => {
    const storage: StorageManagerLike = { estimate: async () => ({ usage: 500, quota: 100 }) };
    expect(await estimateStorage(storage)).toEqual({ usage: 500, quota: 100, available: 0, persisted: null });
  });

  it('estimation qui lève : valeurs inconnues, sans exception', async () => {
    const storage: StorageManagerLike = {
      estimate: async () => {
        throw new Error('indisponible');
      },
    };
    expect(await estimateStorage(storage)).toEqual(UNKNOWN);
  });

  it('API absente : tout est inconnu', async () => {
    expect(await estimateStorage({})).toEqual(UNKNOWN);
  });

  it('navigator sans storage (vieux navigateur) : tout est inconnu', async () => {
    vi.stubGlobal('navigator', {});
    expect(await estimateStorage()).toEqual(UNKNOWN);
  });

  it('navigator absent : tout est inconnu', async () => {
    vi.stubGlobal('navigator', undefined);
    expect(await estimateStorage()).toEqual(UNKNOWN);
  });

  it.each([
    ['usage négatif', { usage: -1, quota: 100 }, { usage: null, quota: 100 }],
    ['quota NaN', { usage: 10, quota: Number.NaN }, { usage: 10, quota: null }],
    ['usage infini', { usage: Number.POSITIVE_INFINITY, quota: 100 }, { usage: null, quota: 100 }],
  ])('valeur invalide (%s) : inconnue, pas d’espace disponible', async (_label, estimate, expected) => {
    const info = await estimateStorage({ estimate: async () => estimate });
    expect(info).toEqual({ ...expected, available: null, persisted: null });
  });

  it('persistance inconnue si son appel lève, estimation conservée', async () => {
    const storage: StorageManagerLike = {
      estimate: async () => ({ usage: 10, quota: 100 }),
      persisted: async () => {
        throw new Error('indisponible');
      },
    };
    expect(await estimateStorage(storage)).toEqual({ usage: 10, quota: 100, available: 90, persisted: null });
  });

  it.each([true, false])('persistance lue telle quelle (%s)', async (persisted) => {
    expect((await estimateStorage({ persisted: async () => persisted })).persisted).toBe(persisted);
  });
});

describe('requestPersistence : demande de persistance', () => {
  it('déjà persisté : vrai, sans rappeler persist', async () => {
    const persist = vi.fn(async () => true);
    expect(await requestPersistence({ persisted: async () => true, persist })).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it('non persisté, navigateur accorde : vrai', async () => {
    const persist = vi.fn(async () => true);
    expect(await requestPersistence({ persisted: async () => false, persist })).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('non persisté, navigateur refuse : faux, sans erreur', async () => {
    expect(await requestPersistence({ persisted: async () => false, persist: async () => false })).toBe(false);
  });

  it('persist qui lève : faux', async () => {
    const storage: StorageManagerLike = {
      persisted: async () => false,
      persist: async () => {
        throw new Error('refus');
      },
    };
    expect(await requestPersistence(storage)).toBe(false);
  });

  it('API absente : faux', async () => {
    expect(await requestPersistence({})).toBe(false);
  });

  it('navigator absent : faux', async () => {
    vi.stubGlobal('navigator', undefined);
    expect(await requestPersistence()).toBe(false);
  });
});
