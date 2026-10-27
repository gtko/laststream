// « Reprendre la lecture » côté amis (LAST-195) : repère et mention seulement si un ami a le titre, « Personne d'autre »
// seulement après la réponse, rien sur échec réseau ni pour un enfant, un seul appel groupé, calcul de l'avance.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth } from '../src/data/auth';
import { friendAhead } from '../src/data/homeSocial';

const h = vi.hoisted(() => ({ st: { friends: [] as any[], activity: [], listDetails: {}, badge: 0 } as any, entries: [] as any[] }));
vi.mock('../src/data/socialStore', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getState: () => h.st,
  subscribe: () => () => undefined,
}));
vi.mock('../src/data/userStore', () => ({ userStore: { continueWatching: () => h.entries } }));
const api = vi.hoisted(() => ({ homeProgress: vi.fn() }));
vi.mock('../src/data/socialV3Api', () => ({ homeProgress: api.homeProgress }));

const ADULT = { id: 'p1', name: 'Greg', avatarColor: '', isKid: false, kidMaxAge: null as number | null, hasPin: false, allowedCatalogs: [], createdAt: '2026-01-01T00:00:00Z' };
function setAccount(p: typeof ADULT | null): void {
  auth.status = p ? 'ready' : 'local';
  auth.profile = p as unknown as typeof auth.profile;
}
const LEA = { pid: 'f1', handle: { name: 'Léa', full: 'Léa#1' }, avatarColor: '#ff5a36', muted: false };
const prog = (o: object = {}) => ({ friend: LEA, type: 'series', tmdbId: 100, season: 2, episode: 4, pos: 600, duration: 3000, finished: false, updatedAt: 1, ...o });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

const card = (key: string) => '<div class="cont-card" data-resume="' + key + '"><span class="card-media"><span class="cont-info"><span class="cont-name">T</span></span></span></div>';
let mod: typeof import('../src/ui/continueSocial.js');

beforeEach(async () => {

  mod ??= await import('../src/ui/continueSocial.js');
  setAccount(ADULT);
  h.st.friends = [LEA];
  h.entries = [
    { key: 'tv:100', type: 'tv', id: '100', season: 2, episode: 3, position: 1500, duration: 3000 },
    { key: 'movie:200', type: 'movie', id: '200', position: 3000, duration: 6000 },
  ];
  api.homeProgress.mockReset().mockResolvedValue({ items: [] });
  document.body.innerHTML = '<div id="cont-slot">' + card('tv:100') + card('movie:200') + '</div>';
});
afterEach(() => { setAccount(null); document.body.innerHTML = ''; });

const lines = () => Array.from(document.querySelectorAll('.cont-card')).map((c) => c.querySelector('.cont-friend')?.textContent ?? null);

describe('avance des amis dans « Reprendre la lecture »', () => {
  it('ami un épisode devant : repère en fin de barre et « Léa a 1 épisode d\'avance » ; titre sans ami : « Personne d\'autre »', async () => {
    api.homeProgress.mockResolvedValue({ items: [prog()] });
    await mod.mountContinueSocial();
    await flush();
    expect(api.homeProgress).toHaveBeenCalledTimes(1);
    expect(api.homeProgress).toHaveBeenCalledWith([{ type: 'series', tmdbId: 100 }, { type: 'movie', tmdbId: 200 }]);
    expect(lines()).toEqual(["Léa a 1 épisode d'avance", "Personne d'autre ne l'a commencé"]);
    const mark = document.querySelector<HTMLElement>('[data-resume="tv:100"] .cont-mark')!;
    expect(mark.textContent).toBe('L');
    expect(mark.style.getPropertyValue('--p')).toBe('100%');
    expect(document.querySelector('[data-resume="movie:200"] .cont-mark')).toBeNull();
  });

  it('même épisode : repère à la position de l\'ami, sans mention d\'avance', async () => {
    api.homeProgress.mockResolvedValue({ items: [prog({ episode: 3, pos: 1860 })] });
    await mod.mountContinueSocial();
    expect(document.querySelector<HTMLElement>('[data-resume="tv:100"] .cont-mark')!.style.getPropertyValue('--p')).toBe('62%');
    expect(lines()[0]).toBeNull();
  });

  it('film : repère à la position, sans mention', async () => {
    api.homeProgress.mockResolvedValue({ items: [prog({ type: 'movie', tmdbId: 200, season: undefined, episode: undefined, pos: 1500, duration: 6000 })] });
    await mod.mountContinueSocial();
    expect(document.querySelector<HTMLElement>('[data-resume="movie:200"] .cont-mark')!.style.getPropertyValue('--p')).toBe('25%');
    expect(lines()[1]).toBeNull();
  });

  it('ami en sourdine : traité comme absent', async () => {
    h.st.friends = [{ ...LEA, muted: true }];
    api.homeProgress.mockResolvedValue({ items: [prog()] });
    await mod.mountContinueSocial();
    expect(lines()[0]).toBe("Personne d'autre ne l'a commencé");
  });

  it('échec réseau : silencieux, ni repère ni « Personne d\'autre », pas de nouvel essai immédiat', async () => {
    api.homeProgress.mockRejectedValue(new Error('boom'));
    await mod.mountContinueSocial();
    expect(lines()).toEqual([null, null]);
    expect(document.querySelector('.cont-mark')).toBeNull();
    await mod.loadContinueSocial();
    expect(api.homeProgress).toHaveBeenCalledTimes(1);
  });

  it('profil enfant ou hors compte : aucun appel, aucune mention', async () => {
    setAccount({ ...ADULT, isKid: true, kidMaxAge: 10 } as typeof ADULT);
    await mod.mountContinueSocial();
    setAccount(null);
    await mod.mountContinueSocial();
    expect(api.homeProgress).not.toHaveBeenCalled();
    expect(lines()).toEqual([null, null]);
  });

  it('rendu répété : réponses gardées, pas de second appel ; nouvelle carte : un seul appel pour elle', async () => {
    api.homeProgress.mockResolvedValue({ items: [prog()] });
    await mod.mountContinueSocial();
    await mod.loadContinueSocial();
    expect(api.homeProgress).toHaveBeenCalledTimes(1);
    document.getElementById('cont-slot')!.insertAdjacentHTML('beforeend', card('movie:300'));
    h.entries.push({ key: 'movie:300', type: 'movie', id: '300', position: 10, duration: 100 });
    await mod.loadContinueSocial();
    expect(api.homeProgress).toHaveBeenCalledTimes(2);
    expect(api.homeProgress).toHaveBeenLastCalledWith([{ type: 'movie', tmdbId: 300 }]);
  });
});

describe('friendAhead', () => {
  const mine = { kind: 'series' as const, season: 2, episode: 3, position: 1500, duration: 3000 };
  it('compte l\'écart en épisodes, au pluriel', () => {
    expect(friendAhead(mine, [prog({ episode: 6, pos: 0 }) as any])?.text).toBe("Léa a 3 épisodes d'avance");
  });
  it('ami en retard : ni repère ni mention ; saison supérieure : mention de position', () => {
    expect(friendAhead(mine, [prog({ episode: 1 }) as any])).toMatchObject({ marker: null, text: '' });
    expect(friendAhead(mine, [prog({ season: 3, episode: 1 }) as any])).toMatchObject({ marker: 100, text: 'Léa est à S3 · É1' });
  });
  it('épisode terminé par l\'ami, moi sur le suivant non commencé : pas d\'avance', () => {
    expect(friendAhead({ ...mine, suggested: true }, [prog({ episode: 2, finished: true }) as any])?.text).toBe('');
  });
  it('aucun ami : null', () => {
    expect(friendAhead(mine, [])).toBeNull();
  });
});
