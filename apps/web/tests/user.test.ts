import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { certAge, kidAllows } from '../src/data/kid';
import { posterPathOf, libraryFromDto } from '../src/data/serverUserStore';
import { clearSession, reloadSession, setSession, saveProfileToken, validProfileToken } from '../src/data/session';
import { applyPrefs, snapshotPrefs } from '../src/data/prefsSync';
import { setRegion } from '../src/data/prefs';

describe('classification pour le profil enfant', () => {
  it('convertit les classifications FR, CH, BE, US et CA en âge', () => {
    expect(certAge('12')).toBe(12);
    expect(certAge('-16')).toBe(16);
    expect(certAge('U')).toBe(0);
    expect(certAge('TP')).toBe(0);
    expect(certAge('AL')).toBe(0);
    expect(certAge('PG')).toBe(8);
    expect(certAge('PG-13')).toBe(13);
    expect(certAge('TV-MA')).toBe(18);
    expect(certAge('18A')).toBe(18);
    expect(certAge('')).toBeNull();
    expect(certAge('zzz')).toBeNull();
  });

  it('refuse l’inconnu et ce qui dépasse l’âge du profil', () => {
    expect(kidAllows('10', 12)).toBe(true);
    expect(kidAllows('12', 12)).toBe(true);
    expect(kidAllows('16', 12)).toBe(false);
    expect(kidAllows(undefined, 12)).toBe(false);
    expect(kidAllows('TV-Y', 10)).toBe(true);
  });
});

describe('adaptateur serveur', () => {
  it('retrouve le chemin d’affiche TMDB et ignore les titres sans TMDB', () => {
    expect(posterPathOf('https://image.tmdb.org/t/p/w342/abc.jpg')).toBe('/abc.jpg');
    expect(posterPathOf('https://exemple.fr/x.jpg')).toBe('');
    const lib = libraryFromDto([
      { type: 'series', tmdbId: 1399, imdbId: null, title: 'GoT', poster: 'https://image.tmdb.org/t/p/w500/p.jpg', addedAt: '2026-01-01T00:00:00Z' },
      { type: 'movie', tmdbId: null, imdbId: 'tt1', title: 'Sans TMDB', poster: null, addedAt: '2026-01-02T00:00:00Z' },
    ]);
    expect(lib).toHaveLength(1);
    expect(lib[0]).toMatchObject({ id: 1399, type: 'tv', poster: '/p.jpg' });
  });
});

describe('session et jetons de profil', () => {
  beforeEach(() => {
    localStorage.clear();
    reloadSession();
  });

  it('garde un jeton de profil tant qu’il est valable', () => {
    setSession('tok', new Date(Date.now() + 1e9).toISOString(), 'greg');
    saveProfileToken('p1', { token: 'pt', expiresAt: new Date(Date.now() + 3600e3).toISOString() });
    saveProfileToken('p2', { token: 'old', expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(validProfileToken('p1')).toBe('pt');
    expect(validProfileToken('p2')).toBeUndefined();
    clearSession();
    expect(validProfileToken('p1')).toBeUndefined();
  });
});

describe('préférences synchronisées', () => {
  it('fait l’aller-retour thème, région et lecture', () => {
    localStorage.clear();
    setRegion('BE');
    applyPrefs({ theme: { id: 'teal' }, autoplay: false, bandwidth: 20, skipIntro: true });
    const s = snapshotPrefs();
    expect(s).toMatchObject({ region: 'BE', autoplay: false, bandwidth: 20, skipIntro: true });
    expect((s.theme as { id: string }).id).toBe('teal');
  });
});

// Intégration réelle : LASTADDON_USER_TEST_URL=http://localhost:7099 (serveur isolé avec LASTADDON_ALLOW_SIGNUP=1).
const REAL = process.env.LASTADDON_USER_TEST_URL;
describe.skipIf(!REAL)('API utilisateur lastAddon (serveur réel)', () => {
  it('inscription, profils, PIN, bibliothèque, progression, réglages', async () => {
    localStorage.clear();
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: REAL, config: 'x' }));
    reloadSettings();
    reloadSession();
    // Bibliothèque locale à migrer à la première connexion.
    localStorage.setItem('laststream.library', JSON.stringify([{ id: 550, type: 'movie', title: 'Fight Club', poster: '/fc.jpg', addedAt: 1 }]));
    const { signUp, auth, unlock, chooseProfile, saveProfile, initAuth, isKidProfile, kidMaxAge, adultsWithPin } = await import('../src/data/auth');
    const { userStore } = await import('../src/data/userStore');
    const name = 'test' + Date.now();
    const status = await signUp(name, 'motdepasse-123');
    expect(status).toBe('needs-profile');
    expect(auth.profiles).toHaveLength(0);

    await saveProfile(null, { name: 'Greg', avatarColor: '#ff5a36', pin: '1234' });
    await saveProfile(null, { name: 'Léo', isKid: true, kidMaxAge: 10, avatarColor: '#19c3a6' });
    expect(auth.profiles.map((p) => p.name)).toEqual(['Greg', 'Léo']);
    const greg = auth.profiles.find((p) => p.name === 'Greg')!;
    const leo = auth.profiles.find((p) => p.name === 'Léo')!;
    expect(greg.hasPin).toBe(true);
    expect(leo).toMatchObject({ isKid: true, kidMaxAge: 10 });
    expect(adultsWithPin().map((p) => p.id)).toEqual([greg.id]);

    await expect(chooseProfile(greg.id)).rejects.toMatchObject({ code: 'pin_required' });
    await expect(unlock(greg.id, '0000')).rejects.toMatchObject({ code: 'invalid_pin' });
    await unlock(greg.id, '1234');
    await chooseProfile(greg.id);
    expect(auth.status).toBe('ready');
    expect(isKidProfile()).toBe(false);

    // Migration de la bibliothèque locale vers le profil serveur.
    expect(userStore.getLibrary().map((e) => e.id)).toEqual([550]);
    userStore.toggleLibrary({ id: 1399, type: 'tv', title: 'GoT', poster: '/got.jpg' });
    await new Promise((r) => setTimeout(r, 300));

    // Rechargement à froid : la session et le profil sont restaurés, la bibliothèque vient du serveur.
    localStorage.removeItem('laststream.library');
    expect(await initAuth()).toBe('ready');
    expect(auth.profile?.id).toBe(greg.id);
    expect(userStore.getLibrary().map((e) => e.id).sort((a, b) => a - b)).toEqual([550, 1399]);

    userStore.setProgress({ key: 'movie:550', type: 'movie', id: 550, title: 'Fight Club', poster: '', position: 600, duration: 6000 });
    await new Promise((r) => setTimeout(r, 300));
    await userStore.loadProgress?.('movie:550');
    expect(userStore.getProgress('movie:550')?.position).toBe(600);

    // Profil enfant : accessible sans PIN, âge maximal exposé.
    await chooseProfile(leo.id);
    expect(isKidProfile()).toBe(true);
    expect(kidMaxAge()).toBe(10);
    expect(userStore.getLibrary()).toEqual([]);
  }, 30000);
});

vi.setConfig({ testTimeout: 30000 });

describe('« vu » : stockage local et serveur', () => {
  it('marque films et épisodes en local', async () => {
    localStorage.clear();
    const { LocalUserStore } = await import('../src/data/userStore');
    const s = new LocalUserStore();
    expect(await s.setWatched('movie:550', null, true)).toBe(true);
    expect(s.isWatched('movie:550')).toBe(true);
    await s.setWatched('tv:1', [{ season: 1, episode: 1 }, { season: 1, episode: 2 }], true);
    expect(s.watchedEpisodes('tv:1')).toEqual([{ season: 1, episode: 1 }, { season: 1, episode: 2 }]);
    expect(s.isWatched('tv:1', 1, 2)).toBe(true);
    await s.setWatched('tv:1', [{ season: 1, episode: 2 }], false);
    expect(s.isWatched('tv:1', 1, 2)).toBe(false);
    expect(s.isWatched('tv:1', 1, 1)).toBe(true);
  });

  async function serverStore(handler: (url: string, init?: RequestInit) => Response) {
    localStorage.clear();
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'x' }));
    reloadSettings();
    setSession('T'.repeat(30), new Date(Date.now() + 1e9).toISOString(), 'greg');
    vi.stubGlobal('fetch', vi.fn(async (u: string, i?: RequestInit) => handler(String(u), i)));
    const { ServerUserStore } = await import('../src/data/serverUserStore');
    return new ServerUserStore([{ id: 'p', name: 'Greg' }], { id: 'p', name: 'Greg' });
  }

  it('envoie le changement au serveur, et le garde en cas de succès', async () => {
    const sent: unknown[] = [];
    const s = await serverStore((_u, init) => { sent.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }); });
    const p = s.setWatched('tv:1399', [{ season: 1, episode: 1 }], true);
    expect(s.isWatched('tv:1399', 1, 1)).toBe(true); // optimiste, avant la réponse
    expect(await p).toBe(true);
    expect(sent[0]).toEqual({ type: 'series', tmdbId: 1399, episodes: [{ season: 1, episode: 1 }], watched: true });
  });

  it('annule le changement si le serveur refuse', async () => {
    const s = await serverStore(() => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
    expect(await s.setWatched('movie:550', null, true)).toBe(false);
    expect(s.isWatched('movie:550')).toBe(false);
    await s.setWatched('tv:1', [{ season: 1, episode: 1 }], true).then((ok) => expect(ok).toBe(false));
    expect(s.isWatched('tv:1', 1, 1)).toBe(false);
  });

  it('garde le local si la route n’existe pas (404)', async () => {
    let calls = 0;
    const s = await serverStore(() => { calls += 1; return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }); });
    expect(await s.setWatched('movie:7', null, true)).toBe(true);
    expect(s.isWatched('movie:7')).toBe(true);
    await s.setWatched('movie:8', null, true);
    expect(calls).toBe(1); // la route n'est plus appelée ensuite
  });

  it('recharge l’état d’une série depuis le serveur', async () => {
    const s = await serverStore(() => new Response(JSON.stringify({ episodes: [{ season: 1, episode: 3, finished: true }, { season: 1, episode: 4, finished: false }] }), { status: 200 }));
    await s.setWatched('tv:9', [{ season: 1, episode: 1 }], true).catch(() => undefined);
    await s.loadWatched('tv:9');
    expect(s.watchedEpisodes('tv:9')).toEqual([{ season: 1, episode: 3 }]);
  });
});

describe('« Reprendre la lecture » : retrait sans perdre la progression', () => {
  it('masque un titre puis le rétablit ; une nouvelle lecture le réaffiche', async () => {
    localStorage.clear();
    const { LocalUserStore } = await import('../src/data/userStore');
    const s = new LocalUserStore();
    const p = { key: 'movie:1', type: 'movie' as const, id: 1, title: 'A', poster: '', position: 600, duration: 6000 };
    s.setProgress(p);
    expect(s.continueWatching().map((x) => x.key)).toEqual(['movie:1']);
    expect(await s.hideContinue('movie:1')).toBe(true);
    expect(s.continueWatching()).toEqual([]);
    expect(s.getProgress('movie:1')?.position).toBe(600); // progression conservée
    await s.showContinue('movie:1');
    expect(s.continueWatching()).toHaveLength(1);
    await s.hideContinue('movie:1');
    s.setProgress({ ...p, position: 900 });
    expect(s.continueWatching()).toHaveLength(1);
  });
});
