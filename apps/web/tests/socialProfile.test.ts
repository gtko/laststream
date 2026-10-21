// Édition du profil social (Social v3, lot F2) : modèle (différences, validation, cooldown, réordonnancement) et formulaire DOM
// (validation, corps envoyé, cooldown du tag, favoris, échappement). Le store, l'API TMDB et le studio d'avatars sont remplacés.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  store: {
    saveProfile: vi.fn(),
    savePrefs: vi.fn(),
    setStatus: vi.fn(),
    rerollTag: vi.fn(),
    loadProfile: vi.fn(),
    loadPrefs: vi.fn(),
    getState: vi.fn(() => ({ status: 'online' })),
  },
  saveAuthProfile: vi.fn(),
  tmdb: vi.fn(),
  studio: vi.fn(),
}));

vi.mock('../src/data/socialStore', () => h.store);
vi.mock('../src/data/auth', () => ({
  auth: { profile: { id: 'p1', avatar: null } },
  isKidProfile: () => false,
  isServerMode: () => true,
  saveProfile: h.saveAuthProfile,
}));
vi.mock('../src/data/lt', () => ({ tmdb: h.tmdb }));
vi.mock('../src/ui/avatar-studio.js', () => ({ openAvatarStudio: h.studio }));
vi.mock('../src/ui/avatar-art.js', () => ({ hydrateAvatars: vi.fn() }));
vi.mock('../src/ui/dom.js', () => ({ detailEl: document.createElement('div'), toast: vi.fn() }));
vi.mock('../src/ui/state.js', () => ({ state: { depth: 0 } }));

import { UserApiError } from '../src/data/userApi';
import { mountProfileEditor } from '../src/ui/socialProfile.js';
import {
  addFavorite, diffDraft, makeDraft, mediaOf, moveItem, tagCooldown, validateDraft,
} from '../src/ui/socialProfileModel.js';

const DAY = 86_400_000;
const PREFS = {
  activityVisibility: 'friends', watchWith: 'ask', libraryVisibility: 'friends', messagesFrom: 'friends',
  historyVisible: true, antiSpoiler: true, playbackSocial: 'all',
  notify: { messages: true, requests: true, parties: true, friendStarts: false, vibrate: false, sound: false },
};
const fav = (id: number, title = 'Film ' + id) => ({ tmdbId: id, type: 'movie', title, poster: '/p' + id + '.jpg' });
const profile = (over: Record<string, unknown> = {}) => ({
  pid: 'me', handle: { name: 'Greg', tag: 'A7K2', full: 'Greg#A7K2' }, avatarColor: '#ff5a36', bio: 'Fan de SF',
  favorites: [fav(1), fav(2)], stats: { hoursWatched: 412, notes: 87, friends: 14 }, ...over,
});
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('modèle du profil social', () => {
  const base = () => makeDraft(profile() as never, PREFS as never, 'online', null);

  it("n'envoie rien tant que rien ne change", () => {
    expect(diffDraft(base(), base())).toEqual({});
  });

  it('répartit les différences par route et ne garde que ce qui change', () => {
    const d = base();
    d.name = '  Greg2 ';
    d.bio = '   ';
    d.presence = 'dnd';
    d.avatar = 'col:pokemon:pikachu';
    d.prefs.watchWith = 'never';
    d.prefs.notify.sound = true;
    expect(diffDraft(base(), d)).toEqual({
      profile: { name: 'Greg2', bio: null },
      avatar: 'col:pokemon:pikachu',
      presence: 'dnd',
      prefs: { watchWith: 'never', notify: { sound: true } },
    });
  });

  it('construit le statut avec son échéance, ou l’efface', () => {
    const now = new Date('2026-10-20T10:00:00').getTime();
    const d = base();
    d.emoji = '🍿'; d.statusText = 'Soirée SF'; d.expiry = '4h';
    expect(diffDraft(base(), d, now).profile).toEqual({ customStatus: { emoji: '🍿', text: 'Soirée SF', expiresAt: now + 4 * 3_600_000 } });
    const b = makeDraft(profile({ customStatus: { emoji: '🍿', text: 'x', expiresAt: now + 1000 } }) as never, PREFS as never, 'online', null);
    const c = JSON.parse(JSON.stringify(b));
    expect(diffDraft(b, c, now)).toEqual({});
    c.emoji = ''; c.statusText = '';
    expect(diffDraft(b, c, now).profile).toEqual({ customStatus: null });
  });

  it('« ce soir » tombe à 23 h 59 le jour même', () => {
    const d = base();
    d.statusText = 'Ce soir'; d.expiry = 'tonight';
    const at = (diffDraft(base(), d, new Date('2026-10-20T10:00:00').getTime()).profile as { customStatus: { expiresAt: number } }).customStatus.expiresAt;
    const date = new Date(at);
    expect([date.getDate(), date.getHours(), date.getMinutes()]).toEqual([20, 23, 59]);
  });

  it('valide pseudo, bio et statut', () => {
    const d = base();
    expect(validateDraft(d)).toEqual({});
    d.name = 'G'; d.bio = 'x'.repeat(141); d.statusText = 'y'.repeat(61);
    expect(Object.keys(validateDraft(d)).sort()).toEqual(['bio', 'name', 'status']);
    d.name = 'Gr<eg>';
    expect(validateDraft(d).name).toBeTruthy();
  });

  it('calcule le cooldown du tag', () => {
    const now = 1_000_000;
    expect(tagCooldown({ tagChangeableAt: undefined } as never, now).locked).toBe(false);
    expect(tagCooldown({ tagChangeableAt: now - 1 } as never, now).locked).toBe(false);
    expect(tagCooldown({ tagChangeableAt: now + 12 * DAY } as never, now)).toMatchObject({ locked: true, label: 'Nouveau tag possible dans 12 jours' });
  });

  it('réordonne et plafonne les favoris', () => {
    const l = [fav(1), fav(2), fav(3)];
    expect(moveItem(l, 0, 2).map((f: { tmdbId: number }) => f.tmdbId)).toEqual([2, 3, 1]);
    expect(moveItem(l, 1, 9).map((f: { tmdbId: number }) => f.tmdbId)).toEqual([1, 2, 3]);
    expect(l.map((f) => f.tmdbId)).toEqual([1, 2, 3]);
    expect(addFavorite(l, fav(2))).toBe(l);
    expect(addFavorite([...l, fav(4)], fav(5))).toHaveLength(4);
    expect(mediaOf({ media_type: 'person', id: 1 })).toBeNull();
    expect(mediaOf({ media_type: 'tv', id: 9, name: 'Série', poster_path: '/a.jpg', backdrop_path: '/b.jpg' })).toMatchObject({ type: 'series', tmdbId: 9, title: 'Série' });
  });
});

describe('formulaire du profil social', () => {
  let root: HTMLElement;
  const mount = (p = profile(), prefs = PREFS) => {
    root = document.createElement('div');
    document.body.replaceChildren(root);
    return mountProfileEditor(root, { profile: p as never, prefs: prefs as never, status: 'online', onBack: vi.fn() });
  };
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const type = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const saveBtn = () => Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Enregistrer') as HTMLButtonElement;

  beforeEach(() => {
    vi.clearAllMocks();
    h.store.saveProfile.mockImplementation(async (patch) => profile({ ...patch, handle: { name: patch.name || 'Greg', tag: 'A7K2', full: (patch.name || 'Greg') + '#A7K2' } }));
    h.store.savePrefs.mockImplementation(async () => PREFS);
    h.store.setStatus.mockResolvedValue(undefined);
  });

  it('affiche le formulaire, sans modification ni bouton de désactivation', () => {
    mount();
    expect(q<HTMLInputElement>('#spf-nm').value).toBe('Greg');
    expect(saveBtn().disabled).toBe(true);
    expect(q('.spf-dirty').hidden).toBe(true);
    expect(root.textContent).not.toContain('Désactiver mon profil social');
    expect(q('.spf-count').textContent).toBe('· 9/140');
  });

  it('signale les modifications non enregistrées et envoie seulement le diff', async () => {
    const ed = mount();
    type(q<HTMLInputElement>('#spf-nm'), 'Gregoire');
    expect(q('.spf-dirty').hidden).toBe(false);
    expect(saveBtn().disabled).toBe(false);
    await ed.save();
    expect(h.store.saveProfile).toHaveBeenCalledWith({ name: 'Gregoire' });
    expect(h.store.savePrefs).not.toHaveBeenCalled();
    expect(h.store.setStatus).not.toHaveBeenCalled();
    expect(ed.isDirty()).toBe(false);
    expect(q('.spf-dirty').hidden).toBe(true);
  });

  it('refuse un pseudo invalide sans appeler le serveur', async () => {
    const ed = mount();
    type(q<HTMLInputElement>('#spf-nm'), 'G');
    await ed.save();
    expect(h.store.saveProfile).not.toHaveBeenCalled();
    expect(q('#spf-nm-err').hidden).toBe(false);
    expect(q('#spf-nm-err').textContent).toContain('2 à 20');
  });

  it('compte la bio et envoie null quand elle est vidée', async () => {
    const ed = mount();
    type(q<HTMLTextAreaElement>('#spf-bio'), 'a'.repeat(150));
    expect(q('.spf-count').textContent).toBe('· 150/140');
    expect(q('.spf-count').classList.contains('over')).toBe(true);
    await ed.save();
    expect(h.store.saveProfile).not.toHaveBeenCalled();
    type(q<HTMLTextAreaElement>('#spf-bio'), '');
    await ed.save();
    expect(h.store.saveProfile).toHaveBeenCalledWith({ bio: null });
  });

  it('envoie les préférences, la présence et l’avatar sur leurs routes', async () => {
    const ed = mount();
    (root.querySelector('[aria-label="Sons de notification"]') as HTMLElement).click();
    (Array.from(root.querySelectorAll('.spf-segb')).find((b) => b.textContent === 'Jamais') as HTMLElement).click();
    (Array.from(root.querySelectorAll('.spf-segb')).find((b) => b.textContent === 'Absent') as HTMLElement).click();
    const opts = h.studio.mock.calls.length;
    (Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Visage d’un personnage') as HTMLElement).click();
    expect(h.studio.mock.calls.length).toBe(opts + 1);
    h.studio.mock.calls[0][0].onPick('col:pokemon:pikachu', '#ffd9cf');
    await ed.save();
    expect(h.store.savePrefs).toHaveBeenCalledWith({ watchWith: 'never', notify: { sound: true } });
    expect(h.store.setStatus).toHaveBeenCalledWith('away');
    expect(h.saveAuthProfile).toHaveBeenCalledWith('p1', { avatar: 'col:pokemon:pikachu' });
    expect(h.store.saveProfile).toHaveBeenCalledWith({ avatarColor: '#ffd9cf' });
  });

  it('garde en brouillon ce que le serveur a refusé', async () => {
    h.store.savePrefs.mockRejectedValue(new UserApiError(500, 'oops'));
    const ed = mount();
    type(q<HTMLInputElement>('#spf-nm'), 'Nouveau');
    (root.querySelector('[aria-label="Sons de notification"]') as HTMLElement).click();
    await ed.save();
    expect(ed.isDirty()).toBe(true);
    expect(ed.diff()).toEqual({ prefs: { notify: { sound: true } } });
    expect(q('.spf-err--top').textContent).toContain('Tout n’a pas été enregistré');
  });

  it('Annuler efface les modifications', () => {
    const ed = mount();
    type(q<HTMLInputElement>('#spf-nm'), 'Autre');
    (Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Annuler') as HTMLElement).click();
    expect(q<HTMLInputElement>('#spf-nm').value).toBe('Greg');
    expect(ed.isDirty()).toBe(false);
  });

  it('bloque le nouveau tag pendant le cooldown et affiche le délai', () => {
    mount(profile({ tagChangeableAt: Date.now() + 12 * DAY }));
    expect((q('[aria-label="Tirer un nouveau tag"]') as HTMLButtonElement).disabled).toBe(true);
    expect(q('.spf-note').textContent).toContain('Nouveau tag possible dans 12 jours');
  });

  it('tire un nouveau tag après confirmation', async () => {
    h.store.rerollTag.mockResolvedValue({ handle: { name: 'Greg', tag: 'ZZ99', full: 'Greg#ZZ99' }, tagChangeableAt: Date.now() + 30 * DAY });
    mount();
    (q('[aria-label="Tirer un nouveau tag"]') as HTMLElement).click();
    expect(h.store.rerollTag).not.toHaveBeenCalled();
    (q('[data-reroll-yes]') as HTMLElement).click();
    await tick();
    expect(h.store.rerollTag).toHaveBeenCalledTimes(1);
    expect(q('.spf-tagf').textContent).toContain('#ZZ99');
    expect((q('[aria-label="Tirer un nouveau tag"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('relit le profil quand le serveur répond tag_cooldown', async () => {
    h.store.rerollTag.mockRejectedValue(new UserApiError(429, 'tag_cooldown'));
    h.store.loadProfile.mockResolvedValue(profile({ tagChangeableAt: Date.now() + 5 * DAY }));
    mount();
    (q('[aria-label="Tirer un nouveau tag"]') as HTMLElement).click();
    (q('[data-reroll-yes]') as HTMLElement).click();
    await tick();
    expect(h.store.loadProfile).toHaveBeenCalled();
    expect((q('[aria-label="Tirer un nouveau tag"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('ajoute un favori par recherche, le retire et le réordonne', async () => {
    h.tmdb.mockResolvedValue({ results: [{ media_type: 'movie', id: 7, title: 'Parasite', poster_path: '/pa.jpg', backdrop_path: '/pb.jpg' }, { media_type: 'person', id: 8, name: 'Quelqu’un' }] });
    const ed = mount();
    (q('[aria-label="Ajouter un favori"]') as HTMLElement).click();
    const input = document.querySelector('.spf-modal input') as HTMLInputElement;
    vi.useFakeTimers();
    type(input, 'parasite');
    await vi.advanceTimersByTimeAsync(350);
    vi.useRealTimers();
    await tick();
    const results = document.querySelectorAll('.spf-r');
    expect(results).toHaveLength(1);
    (results[0] as HTMLElement).click();
    expect(ed.draft.favorites.map((f: { tmdbId: number }) => f.tmdbId)).toEqual([1, 2, 7]);
    (q('[aria-label="Déplacer Parasite vers la gauche"]') as HTMLElement).click();
    expect(ed.draft.favorites.map((f: { tmdbId: number }) => f.tmdbId)).toEqual([1, 7, 2]);
    (q('[aria-label="Retirer Film 1"]') as HTMLElement).click();
    expect(ed.draft.favorites.map((f: { tmdbId: number }) => f.tmdbId)).toEqual([7, 2]);
    await ed.save();
    expect(h.store.saveProfile.mock.calls[0][0].favorites.map((f: { tmdbId: number }) => f.tmdbId)).toEqual([7, 2]);
  });

  it('choisit la bannière avec un backdrop', async () => {
    h.tmdb.mockResolvedValue({ results: [{ media_type: 'movie', id: 1, title: 'Sans image' }, { media_type: 'tv', id: 5, name: 'Dark', backdrop_path: '/d.jpg' }] });
    const ed = mount();
    (Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Choisir') as HTMLElement).click();
    vi.useFakeTimers();
    type(document.querySelector('.spf-modal input') as HTMLInputElement, 'dark');
    await vi.advanceTimersByTimeAsync(350);
    vi.useRealTimers();
    await tick();
    const results = document.querySelectorAll('.spf-r');
    expect(results).toHaveLength(1);
    (results[0] as HTMLElement).click();
    await ed.save();
    expect(h.store.saveProfile).toHaveBeenCalledWith({ banner: { tmdbId: 5, type: 'series', backdrop: '/d.jpg', title: 'Dark' } });
  });

  it("n'écrit jamais le texte « null » (favoris, puces du statut personnalisé)", () => {
    mount(profile({ favorites: [fav(1), fav(2), fav(3)], customStatus: { emoji: '🍿', text: 'x' } }));
    expect(q('.spf-favs').textContent).not.toContain('null');
    expect(q('.spf-exp').textContent).not.toContain('null');
    expect(root.textContent).not.toContain('null');
    mount(profile({ customStatus: { emoji: '🍿', text: 'x', expiresAt: Date.now() + DAY } }));
    expect(q('.spf-exp').textContent).toContain('Efface le');
    expect(q('.spf-exp').textContent).not.toContain('null');
  });

  it('pose la couleur des vignettes sans raccourci background (cadrage cover/center du CSS conservé)', () => {
    mount(profile({ favorites: [fav(1), fav(2)] }));
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('.spf-fav[data-i], .spf-pf:not(.empty)'))) {
      expect(el.style.backgroundColor).not.toBe('');
      expect(el.style.backgroundSize).toBe('');
      expect(el.style.backgroundPosition).toBe('');
    }
  });

  it('affiche les textes utilisateur comme du texte', () => {
    mount(profile({ bio: '<img src=x onerror=alert(1)>', favorites: [fav(1, '<b>Gras</b>')] }));
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('.spf-prev-bio')?.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(root.querySelector('.spf-fav b')).toBeNull();
  });
});

describe('version Android (< 768 px)', () => {
  it('ouvre une feuille de choix et envoie le choix', async () => {
    window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as never;
    h.store.savePrefs.mockResolvedValue(PREFS);
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const ed = mountProfileEditor(root, { profile: profile() as never, prefs: PREFS as never, status: 'online', onBack: vi.fn() });
    expect(root.querySelector('.spf--m')).not.toBeNull();
    expect(root.querySelector('.spf-seg')).toBeNull();
    expect(root.textContent).toContain('Notifications Android');
    (Array.from(root.querySelectorAll('button.spf-li')).find((b) => b.textContent?.includes('Regarder avec moi')) as HTMLElement).click();
    const opt = Array.from(root.querySelectorAll('.spf-opt')).find((b) => b.textContent === 'Jamais') as HTMLElement;
    opt.click();
    expect(root.querySelector('.spf-sheet')).toBeNull();
    await ed.save();
    expect(h.store.savePrefs).toHaveBeenCalledWith({ watchWith: 'never' });
    delete (window as { matchMedia?: unknown }).matchMedia;
  });
});
