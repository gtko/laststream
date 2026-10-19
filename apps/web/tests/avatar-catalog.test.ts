import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AVATAR_PATTERN, COL_PATTERN, formatColAvatar, isValidAvatar, parseAvatar, parseColAvatar,
} from '../src/data/avatars';
import {
  AvatarCatalogError, avatarImageUrl, groupCollections, isKidAllowed, kidCollections, loadCatalog, loadCollection,
  pushRecentAvatar, recentAvatars, resetAvatarCatalog, searchCatalog, searchCharacters, suggestFromWatching, watchingTitles,
  type Catalog,
} from '../src/data/avatar-catalog';
import { SETTINGS_STORAGE_KEY, reloadSettings } from '../src/data/config';
import { avatarAttrs, hydrateAvatars } from '../src/ui/avatar-art.js';

const BASE = 'http://srv.test';
const CATALOG_KEY = 'laststream.avatars.catalog';

/** Catalogue tel que servi par lastAddon (champs bruts, avant normalisation). */
const RAW_CATALOG = {
  version: '2026-10-20',
  families: [
    { id: 'games', label: 'Jeux vidéo' },
    { id: 'heroes', label: 'Super-héros' },
    { id: 'disney', label: 'Disney et films' },
  ],
  collections: [
    { id: 'pokemon-officiel', family: 'games', name: 'Pokémon', source: 'PokeAPI', license: 'propriétaire', free: false, kid: true, total: 1025, aliases: ['pokemon', 'pokémon'], group: 'pokemon', style: 'Artwork officiel', previews: ['pikachu', 'bulbizarre', 'salameche', 'carapuce', 'evoli', 'dracaufeu', 'mewtwo', 'ronflex'] },
    { id: 'pokemon-home', family: 'games', name: 'Pokémon', source: 'HOME', license: 'propriétaire', free: false, kid: true, total: 900, aliases: ['pokemon'], group: 'pokemon', style: 'HOME 3D', previews: ['pikachu', 'dracaufeu'] },
    { id: 'marvel-heros', family: 'heroes', name: 'Marvel', source: 'Marvel', license: 'propriétaire', free: false, kid: false, total: 3, aliases: ['marvel comics'], previews: ['iron-man', 'captain-america', 'hulk'] },
    { id: 'disney-classiques', family: 'disney', name: 'Disney', source: 'Disney', license: 'propriétaire', free: false, kid: true, total: 2, aliases: ['disney', 'walt disney'], previews: ['mickey', 'donald'] },
    { id: 'mario-amiibo', family: 'games', name: 'Mario', source: 'Nintendo', license: 'propriétaire', free: false, kid: true, total: 3, aliases: ['super mario'], previews: ['mario', 'luigi', 'peach'] },
  ],
  featured: ['col:pokemon-officiel:pikachu', 'col:marvel-heros:iron-man', 'pas-un-avatar'],
};

const CHARACTERS: Record<string, { id: string; name: string }[]> = {
  'pokemon-officiel': [{ id: 'pikachu', name: 'Pikachu' }, { id: 'bulbizarre', name: 'Bulbizarre' }, { id: 'dracaufeu', name: 'Dracaufeu' }],
  'pokemon-home': [{ id: 'pikachu', name: 'Pikachu' }, { id: 'dracaufeu', name: 'Dracaufeu' }],
  'marvel-heros': [{ id: 'iron-man', name: 'Iron Man' }, { id: 'hulk', name: 'Hulk' }, { id: 'spider-man', name: 'Spider-Man' }],
  'disney-classiques': [{ id: 'mickey', name: 'Mickey Mouse' }, { id: 'donald', name: 'Donald Duck' }],
  'mario-amiibo': [{ id: 'mario', name: 'Mario' }, { id: 'luigi', name: 'Luigi' }, { id: 'peach', name: 'Peach' }],
};

const reply = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** Fixture normalisée (comme le renvoie loadCatalog). */
const catalog = (): Catalog => ({
  version: RAW_CATALOG.version,
  families: RAW_CATALOG.families,
  collections: RAW_CATALOG.collections.map((c) => ({ ...c, aliases: [...c.aliases], previews: [...c.previews] })) as Catalog['collections'],
  featured: RAW_CATALOG.featured.slice(0, 2),
});

function setBase(base: string): void {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base, config: 'X' }));
  reloadSettings();
}

/** Serveur simulé : catalogue et fichiers de personnages. */
function serve(overrides: Record<string, () => unknown> = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    const path = url.slice(BASE.length);
    if (overrides[path]) return overrides[path]();
    if (path === '/avatars/catalog.json') return reply(RAW_CATALOG);
    const m = /^\/avatars\/c\/([a-z0-9-]+)\.json$/.exec(path);
    if (m && CHARACTERS[m[1]]) return reply({ id: m[1], characters: CHARACTERS[m[1]] });
    return reply({ error: 'not_found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setBase(BASE);
  resetAvatarCatalog();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('format col:<colId>:<charId>', () => {
  it('formate et relit un avatar de collection', () => {
    expect(formatColAvatar('pokemon-officiel', 'pikachu')).toBe('col:pokemon-officiel:pikachu');
    expect(parseColAvatar('col:pokemon-officiel:pikachu')).toEqual({ colId: 'pokemon-officiel', charId: 'pikachu' });
    expect(COL_PATTERN.test('col:a:b')).toBe(true);
  });

  it('rejette les formats invalides', () => {
    const longId = 'a'.repeat(49);
    for (const bad of ['col:Pokemon:pikachu', 'col::pikachu', 'col:pokemon:', 'col:pokemon:pi kachu', `col:${longId}:x`, 'col:a:b:c', 'pokemon:pikachu', 'col:-a:b', '', 'col:a:é']) {
      expect(parseColAvatar(bad), bad).toBeNull();
      expect(isValidAvatar(bad), bad).toBe(false);
    }
    expect(parseColAvatar(null)).toBeNull();
    expect(parseColAvatar(42)).toBeNull();
  });

  it('accepte un identifiant de 48 caractères', () => {
    const id = 'a'.repeat(48);
    expect(parseColAvatar(`col:${id}:${id}`)).toEqual({ colId: id, charId: id });
  });

  it('isValidAvatar accepte col: et garde DiceBear et Héros ; col: n’est pas un DiceBear', () => {
    expect(isValidAvatar('col:pokemon-officiel:pikachu')).toBe(true);
    expect(isValidAvatar('dicebear:thumbs:Mimi')).toBe(true);
    expect(isValidAvatar('hero:heros:Aegis')).toBe(true);
    expect(AVATAR_PATTERN.test('col:pokemon-officiel:pikachu')).toBe(false);
    expect(parseAvatar('col:pokemon-officiel:pikachu')).toBeNull();
  });
});

describe('adresse des vignettes', () => {
  it('suit l’adresse lastAddon réglée', () => {
    expect(avatarImageUrl('pokemon-officiel', 'pikachu')).toBe(BASE + '/avatars/i/pokemon-officiel/pikachu.webp');
  });

  it('vide sans adresse lastAddon ou avec un identifiant invalide', () => {
    setBase('');
    expect(avatarImageUrl('pokemon-officiel', 'pikachu')).toBe('');
    setBase(BASE);
    expect(avatarImageUrl('../etc', 'pikachu')).toBe('');
    expect(avatarImageUrl('pokemon-officiel', 'Pikachu')).toBe('');
  });
});

describe('catalogue', () => {
  it('charge /avatars/catalog.json, normalise et garde les « featured » valides', async () => {
    const fetchMock = serve();
    const cat = await loadCatalog();
    expect(fetchMock.mock.calls[0][0]).toBe(BASE + '/avatars/catalog.json');
    expect(cat.version).toBe('2026-10-20');
    expect(cat.families.map((f) => f.id)).toEqual(['games', 'heroes', 'disney']);
    expect(cat.collections).toHaveLength(5);
    expect(cat.collections[0]).toMatchObject({ id: 'pokemon-officiel', group: 'pokemon', style: 'Artwork officiel', kid: true });
    expect(cat.collections[2].group).toBeUndefined();
    expect(cat.featured).toEqual(['col:pokemon-officiel:pikachu', 'col:marvel-heros:iron-man']);
  });

  it('met en cache mémoire et en sessionStorage : un seul appel réseau', async () => {
    const fetchMock = serve();
    await loadCatalog();
    await loadCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem(CATALOG_KEY) ?? '{}').base).toBe(BASE);
  });

  it('relit la session sans réseau après une remise à zéro de la mémoire, sauf si expirée', async () => {
    const fetchMock = serve();
    sessionStorage.setItem(CATALOG_KEY, JSON.stringify({ base: BASE, at: Date.now() - 1000, data: catalog() }));
    const cat = await loadCatalog();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cat.collections).toHaveLength(5);
    sessionStorage.setItem(CATALOG_KEY, JSON.stringify({ base: BASE, at: Date.now() - 2 * 60 * 60 * 1000, data: catalog() }));
    resetAvatarCatalog();
    sessionStorage.setItem(CATALOG_KEY, JSON.stringify({ base: BASE, at: Date.now() - 2 * 60 * 60 * 1000, data: catalog() }));
    await loadCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('hors ligne : rejet propre (code offline), rien n’est gardé pour le prochain essai', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(reply(RAW_CATALOG));
    vi.stubGlobal('fetch', fetchMock);
    const err = await loadCatalog().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AvatarCatalogError);
    expect((err as AvatarCatalogError).code).toBe('offline');
    expect((await loadCatalog()).collections).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('erreur HTTP et données inexploitables : rejet avec un code', async () => {
    serve({ '/avatars/catalog.json': () => reply({}, 500) });
    await expect(loadCatalog()).rejects.toMatchObject({ code: 'http_500' });
    resetAvatarCatalog();
    serve({ '/avatars/catalog.json': () => reply({ families: [], collections: 'non' }) });
    await expect(loadCatalog()).rejects.toMatchObject({ code: 'bad_catalog' });
  });

  it('sans adresse lastAddon : rejet not_configured, aucun appel réseau', async () => {
    const fetchMock = serve();
    setBase('');
    await expect(loadCatalog()).rejects.toMatchObject({ code: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('personnages d’une collection', () => {
  it('charge /avatars/c/<colId>.json et garde le cache', async () => {
    const fetchMock = serve();
    const data = await loadCollection('pokemon-officiel');
    expect(data.id).toBe('pokemon-officiel');
    expect(data.characters[0]).toEqual({ id: 'pikachu', name: 'Pikachu' });
    await loadCollection('pokemon-officiel');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('identifiant invalide : rejet sans appel réseau ; échec non gardé', async () => {
    const fetchMock = serve({ '/avatars/c/mario-amiibo.json': () => reply({}, 503) });
    await expect(loadCollection('../secret')).rejects.toMatchObject({ code: 'invalid_id' });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(loadCollection('mario-amiibo')).rejects.toMatchObject({ code: 'http_503' });
    serve();
    await expect(loadCollection('mario-amiibo')).resolves.toMatchObject({ id: 'mario-amiibo' });
  });
});

describe('regroupement et profil enfant', () => {
  it('une entrée par univers, les collections sans groupe forment leur propre groupe', () => {
    const groups = groupCollections(catalog());
    expect(groups.map((g) => g.id)).toEqual(['pokemon', 'marvel-heros', 'disney-classiques', 'mario-amiibo']);
    const pokemon = groups[0];
    expect(pokemon.name).toBe('Pokémon');
    expect(pokemon.family).toBe('games');
    expect(pokemon.styles.map((s) => s.style)).toEqual(['Artwork officiel', 'HOME 3D']);
    expect(groups[1].styles.map((s) => s.id)).toEqual(['marvel-heros']);
  });

  it('kidCollections ne garde que les collections enfant', () => {
    expect(kidCollections(catalog()).map((c) => c.id)).toEqual(['pokemon-officiel', 'pokemon-home', 'disney-classiques', 'mario-amiibo']);
  });

  it('isKidAllowed : col: seulement pour une collection enfant ; DiceBear et Héros inchangés ; sans avatar : permis', () => {
    const cat = catalog();
    expect(isKidAllowed(cat, 'col:pokemon-officiel:pikachu')).toBe(true);
    expect(isKidAllowed(cat, 'col:marvel-heros:iron-man')).toBe(false);
    expect(isKidAllowed(cat, 'col:inconnue:x')).toBe(false);
    expect(isKidAllowed(cat, 'dicebear:thumbs:Mimi')).toBe(true);
    expect(isKidAllowed(cat, 'hero:vilains:Blaze')).toBe(true);
    expect(isKidAllowed(cat, 'n’importe quoi')).toBe(false);
    expect(isKidAllowed(cat, null)).toBe(true);
  });
});

describe('avatars récents par profil', () => {
  it('ajoute en tête, sans doublon, 12 au plus, par profil', () => {
    expect(recentAvatars('p1')).toEqual([]);
    pushRecentAvatar('p1', 'col:pokemon-officiel:pikachu');
    pushRecentAvatar('p1', 'dicebear:thumbs:Mimi');
    pushRecentAvatar('p1', 'col:pokemon-officiel:pikachu');
    expect(recentAvatars('p1')).toEqual(['col:pokemon-officiel:pikachu', 'dicebear:thumbs:Mimi']);
    expect(recentAvatars('p2')).toEqual([]);
    for (let i = 0; i < 15; i += 1) pushRecentAvatar('p1', formatColAvatar('mario-amiibo', 'm' + i));
    const list = recentAvatars('p1');
    expect(list).toHaveLength(12);
    expect(list[0]).toBe('col:mario-amiibo:m14');
    expect(JSON.parse(localStorage.getItem('laststream.avatars.recent.p1') ?? '[]')).toHaveLength(12);
  });

  it('ignore les valeurs invalides, et une lecture corrompue donne []', () => {
    pushRecentAvatar('p1', 'col:Mauvais:format');
    expect(localStorage.getItem('laststream.avatars.recent.p1')).toBeNull();
    localStorage.setItem('laststream.avatars.recent.p1', '{pas du json');
    expect(recentAvatars('p1')).toEqual([]);
    localStorage.setItem('laststream.avatars.recent.p1', JSON.stringify(['col:pokemon-officiel:pikachu', 42, 'x']));
    expect(recentAvatars('p1')).toEqual(['col:pokemon-officiel:pikachu']);
  });
});

describe('suggestions « D’après ce que tu regardes »', () => {
  it('rapproche les titres (accents, ponctuation) des noms et alias, aperçus à tour de rôle', () => {
    const out = suggestFromWatching(catalog(), ['Pokémon : Journeys']);
    expect(out).toEqual([
      { colId: 'pokemon-officiel', charId: 'pikachu' },
      { colId: 'pokemon-home', charId: 'pikachu' },
      { colId: 'pokemon-officiel', charId: 'bulbizarre' },
      { colId: 'pokemon-home', charId: 'dracaufeu' },
      { colId: 'pokemon-officiel', charId: 'salameche' },
      { colId: 'pokemon-officiel', charId: 'carapuce' },
      { colId: 'pokemon-officiel', charId: 'evoli' },
      { colId: 'pokemon-officiel', charId: 'dracaufeu' },
      { colId: 'pokemon-officiel', charId: 'mewtwo' },
      { colId: 'pokemon-officiel', charId: 'ronflex' },
    ]);
  });

  it('reconnaît un alias (Super Mario Bros) et ne compte pas une sous-chaîne (Pokemonastery)', () => {
    expect(suggestFromWatching(catalog(), ['Super Mario Bros'])).toEqual([
      { colId: 'mario-amiibo', charId: 'mario' },
      { colId: 'mario-amiibo', charId: 'luigi' },
      { colId: 'mario-amiibo', charId: 'peach' },
    ]);
    expect(suggestFromWatching(catalog(), ['Pokemonastery'])).toEqual([]);
  });

  it('au plus 12 avatars, sans doublon ; aucun titre reconnu : []', () => {
    const many = suggestFromWatching(catalog(), ['Marvel', 'Pokémon', 'Disney', 'Mario']);
    expect(many.length).toBe(12);
    expect(new Set(many.map((s) => s.colId + ':' + s.charId)).size).toBe(many.length);
    expect(suggestFromWatching(catalog(), ['Un film sans rapport', ''])).toEqual([]);
  });
});

describe('recherche', () => {
  it('collections : nom et alias, insensible aux accents ; requête trop courte : []', () => {
    expect(searchCatalog(catalog(), 'poké').map((c) => c.id)).toEqual(['pokemon-officiel', 'pokemon-home']);
    expect(searchCatalog(catalog(), 'walt').map((c) => c.id)).toEqual(['disney-classiques']);
    expect(searchCatalog(catalog(), 'a')).toEqual([]);
    expect(searchCatalog(catalog(), 'marvel', { kidOnly: true })).toEqual([]);
    expect(searchCatalog(catalog(), 'mario', { limit: 1 }).map((c) => c.id)).toEqual(['mario-amiibo']);
  });

  it('personnages : nom du personnage, avec le nom de la collection', async () => {
    serve();
    const hits = await searchCharacters(catalog(), 'iron');
    expect(hits).toEqual([{ colId: 'marvel-heros', charId: 'iron-man', name: 'Iron Man', colName: 'Marvel' }]);
  });

  it('personnages : une collection dont le nom correspond passe en premier et livre tous ses personnages', async () => {
    serve();
    const hits = await searchCharacters(catalog(), 'pokemon', 3);
    expect(hits.map((h) => h.colId + ':' + h.charId)).toEqual(['pokemon-officiel:pikachu', 'pokemon-officiel:bulbizarre', 'pokemon-officiel:dracaufeu']);
  });

  it('personnages : au plus 6 chargements simultanés', async () => {
    const cat = catalog();
    const ids = Array.from({ length: 10 }, (_, i) => 'serie-' + i);
    cat.collections = ids.map((id) => ({ ...cat.collections[2], id, name: 'Série ' + id, aliases: [], previews: [] }));
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn(async (url: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      const m = /\/avatars\/c\/(.+)\.json$/.exec(url);
      return reply({ id: m?.[1], characters: [{ id: 'perso', name: 'Perso ' + m?.[1] }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const hits = await searchCharacters(cat, 'perso', 100);
    expect(hits).toHaveLength(10);
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(peak).toBeLessThanOrEqual(6);
    expect(await searchCharacters(cat, 'a', 100)).toEqual([]);
    expect(await searchCharacters(cat, 'perso', 0)).toEqual([]);
  });
});

describe('titres regardés', () => {
  it('renvoie les titres de la bibliothèque du profil, sans erreur', async () => {
    localStorage.setItem('laststream.library', JSON.stringify([
      { id: 1, type: 'movie', title: 'Iron Man', poster: '', addedAt: 1 },
      { id: 2, type: 'tv', title: 'Pokémon Journeys', poster: '', addedAt: 2 },
    ]));
    const titles = await watchingTitles();
    expect(Array.isArray(titles)).toBe(true);
    expect(titles).toContain('Pokémon Journeys');
    expect(titles).toContain('Iron Man');
    expect(titles.indexOf('Pokémon Journeys')).toBeLessThan(titles.indexOf('Iron Man'));
  });
});

describe('rendu des avatars « collection »', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('avant hydratation : couleur de repli et data-avatar, aucune image', () => {
    const attrs = avatarAttrs('col:pokemon-officiel:pikachu', '#7b5bf5');
    expect(attrs).toContain('data-avatar="col:pokemon-officiel:pikachu"');
    expect(attrs).not.toContain('data-art');
    expect(avatarAttrs('col:Mauvais:format', '#7b5bf5')).not.toContain('data-avatar');
  });

  it('hydratation : une <img> WebP sur la couleur du profil ; échec : l’initiale reste, sans nouvelle tentative', async () => {
    document.body.innerHTML = '<span id="x" class="pf-av"' + avatarAttrs('col:pokemon-officiel:pikachu', '#7b5bf5') + '>P</span>';
    const x = document.getElementById('x') as HTMLElement;
    await hydrateAvatars(document);
    const img = x.querySelector('img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe(BASE + '/avatars/i/pokemon-officiel/pikachu.webp');
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
    expect(x.dataset.artPending).toBe('1');
    expect(x.dataset.art).toBeUndefined();
    // Pas de seconde image pendant le chargement.
    await hydrateAvatars(document);
    expect(x.querySelectorAll('img')).toHaveLength(1);
    // Chargé : l’illustration remplace l’initiale.
    img.dispatchEvent(new Event('load'));
    expect(x.dataset.art).toBe('1');
    expect(x.dataset.artPending).toBeUndefined();
    // Échec sur un autre profil : l’image disparaît, l’élément garde couleur et initiale, et n’est plus retenté.
    document.body.innerHTML = '<span id="y" class="soc-av"' + avatarAttrs('col:marvel-heros:hulk', '#7b5bf5') + '>H</span>';
    const y = document.getElementById('y') as HTMLElement;
    await hydrateAvatars(document);
    (y.querySelector('img') as HTMLImageElement).dispatchEvent(new Event('error'));
    expect(y.querySelector('img')).toBeNull();
    expect(y.dataset.artFailed).toBe('1');
    expect(y.textContent).toBe('H');
    await hydrateAvatars(document);
    expect(y.querySelector('img')).toBeNull();
  });

  it('sans adresse lastAddon : aucune image, la couleur et l’initiale restent', async () => {
    setBase('');
    document.body.innerHTML = '<span id="z"' + avatarAttrs('col:pokemon-officiel:pikachu', '#7b5bf5') + '>P</span>';
    await hydrateAvatars(document);
    expect((document.getElementById('z') as HTMLElement).querySelector('img')).toBeNull();
    expect((document.getElementById('z') as HTMLElement).style.background).toContain('rgb(123, 91, 245)');
  });
});
