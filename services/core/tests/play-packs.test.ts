import { describe, expect, it } from 'vitest';
import { PackStore, type PackFile } from '../src/play/packs.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';
const DAY = 24 * 60 * 60 * 1000;

const clock = (start = 1_000_000) => {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
};

const SERIES_PACK: PackFile[] = [
  { idx: 0, name: 'Show/Show - S01E01 - Pilot.mkv', size: 900 },
  { idx: 1, name: 'Show/Show - S01E02.mkv', size: 850 },
  { idx: 2, name: 'Show/Show.1x03.mkv', size: 800 },
  { idx: 3, name: 'Show/Season 1/Show - 1x04.mkv', size: 700 },
  { idx: 4, name: 'Show/Show - S02E01.mkv', size: 650 },
  { idx: 5, name: 'Show/readme.txt', size: 2 },
];

describe('PackStore : apprentissage et lecture', () => {
  it('learn puis get renvoie les fichiers triés par index, en copie', () => {
    const store = new PackStore({ now: clock().now });
    const shuffled = [SERIES_PACK[3], SERIES_PACK[0], SERIES_PACK[5]] as PackFile[];
    expect(store.learn(HASH, shuffled)).toBe(true);
    const files = store.get(HASH);
    expect(files?.map((file) => file.idx)).toEqual([0, 3, 5]);
    const first = files?.[0];
    if (first) first.size = 1;
    expect(store.get(HASH)?.[0]?.size).toBe(900);
  });

  it('l info-hash est normalisé (casse, espaces)', () => {
    const store = new PackStore({ now: clock().now });
    store.learn(`  ${HASH.toUpperCase()} `, SERIES_PACK);
    expect(store.get(HASH)).toHaveLength(SERIES_PACK.length);
    expect(store.get(HASH.toUpperCase())).toHaveLength(SERIES_PACK.length);
  });

  it('refuse un info-hash invalide, sans rien stocker', () => {
    const store = new PackStore({ now: clock().now });
    expect(store.learn('pas-un-hash', SERIES_PACK)).toBe(false);
    expect(store.learn('0123', SERIES_PACK)).toBe(false);
    expect(store.get('pas-un-hash')).toBeUndefined();
    expect(store.toJSON().packs).toEqual([]);
  });

  it('ignore les fichiers mal formés et refuse un pack sans fichier valide', () => {
    const store = new PackStore({ now: clock().now });
    const messy = [
      { idx: -1, name: 'a.mkv', size: 1 },
      { idx: 1.5, name: 'b.mkv', size: 1 },
      { idx: 2, name: 'c.mkv', size: Number.NaN },
      { idx: 3, name: 42, size: 1 },
      { idx: 4, name: 'd.mkv', size: -1 },
      { idx: 5, name: 'ok.mkv', size: 10 },
      { idx: 5, name: 'doublon.mkv', size: 10 },
    ] as unknown as PackFile[];
    expect(store.learn(HASH, messy)).toBe(true);
    expect(store.get(HASH)).toEqual([{ idx: 5, name: 'ok.mkv', size: 10 }]);
    expect(store.learn(OTHER, [{ idx: -1, name: 'x', size: 1 }])).toBe(false);
    expect(store.get(OTHER)).toBeUndefined();
    expect(store.learn(OTHER, null as unknown as PackFile[])).toBe(false);
  });

  it('tronque les noms trop longs', () => {
    const store = new PackStore({ now: clock().now });
    store.learn(HASH, [{ idx: 0, name: 'x'.repeat(2000), size: 1 }]);
    expect(store.get(HASH)?.[0]?.name).toHaveLength(512);
  });

  it('learn remplace les fichiers précédemment appris pour le même hash', () => {
    const store = new PackStore({ now: clock().now });
    store.learn(HASH, SERIES_PACK);
    store.learn(HASH, [{ idx: 9, name: 'nouveau.mkv', size: 3 }]);
    expect(store.get(HASH)).toEqual([{ idx: 9, name: 'nouveau.mkv', size: 3 }]);
  });
});

describe('PackStore : findEpisode', () => {
  const store = (): PackStore => {
    const s = new PackStore({ now: clock().now });
    s.learn(HASH, SERIES_PACK);
    return s;
  };

  it('retrouve un épisode au format S01E02 et renvoie idx, nom et taille', () => {
    expect(store().findEpisode(HASH, 1, 2)).toEqual({ idx: 1, name: 'Show/Show - S01E02.mkv', size: 850 });
  });

  it('reconnaît le format 1x03', () => {
    expect(store().findEpisode(HASH, 1, 3)).toEqual({ idx: 2, name: 'Show/Show.1x03.mkv', size: 800 });
  });

  it('ne lit que le nom sans dossier : le dossier « Season 1 » n influence pas le résultat', () => {
    expect(store().findEpisode(HASH, 1, 4)).toEqual({ idx: 3, name: 'Show/Season 1/Show - 1x04.mkv', size: 700 });
    expect(store().findEpisode(HASH, 1, 5)).toBeUndefined();
  });

  it('distingue la saison : S02E01 n est pas S01E01', () => {
    expect(store().findEpisode(HASH, 2, 1)?.idx).toBe(4);
    expect(store().findEpisode(HASH, 1, 1)?.idx).toBe(0);
  });

  it('si plusieurs fichiers correspondent, le plus gros l emporte', () => {
    const s = new PackStore({ now: clock().now });
    s.learn(HASH, [
      { idx: 0, name: 'sample/Show.S01E02.sample.mkv', size: 10 },
      { idx: 1, name: 'Show.S01E02.mkv', size: 500 },
      { idx: 2, name: 'Show.S01E02.alt.mkv', size: 400 },
    ]);
    expect(s.findEpisode(HASH, 1, 2)).toEqual({ idx: 1, name: 'Show.S01E02.mkv', size: 500 });
  });

  it('un nom sans saison (« Episode 7 ») ne correspond pas à une saison demandée', () => {
    const s = new PackStore({ now: clock().now });
    s.learn(HASH, [{ idx: 0, name: 'Show - Episode 7.mkv', size: 10 }]);
    expect(s.findEpisode(HASH, 1, 7)).toBeUndefined();
  });

  it('renvoie undefined pour un hash inconnu ou des numéros invalides', () => {
    const s = store();
    expect(s.findEpisode(OTHER, 1, 2)).toBeUndefined();
    expect(s.findEpisode('nope', 1, 2)).toBeUndefined();
    expect(s.findEpisode(HASH, -1, 2)).toBeUndefined();
    expect(s.findEpisode(HASH, 1, 1.5)).toBeUndefined();
    expect(s.findEpisode(HASH, Number.NaN, 2)).toBeUndefined();
  });

  it('le résultat est une copie', () => {
    const s = store();
    const found = s.findEpisode(HASH, 1, 2);
    if (found) found.size = 1;
    expect(s.findEpisode(HASH, 1, 2)?.size).toBe(850);
  });
});

describe('PackStore : bornes (TTL et LRU)', () => {
  it('un pack expire après ttlMs (30 jours par défaut)', () => {
    const t = clock();
    const store = new PackStore({ now: t.now });
    store.learn(HASH, SERIES_PACK);
    t.advance(30 * DAY - 1);
    expect(store.findEpisode(HASH, 1, 2)).toBeDefined();
    t.advance(1);
    expect(store.get(HASH)).toBeUndefined();
    expect(store.findEpisode(HASH, 1, 2)).toBeUndefined();
  });

  it('ttlMs personnalisé', () => {
    const t = clock();
    const store = new PackStore({ ttlMs: 1_000, now: t.now });
    store.learn(HASH, SERIES_PACK);
    t.advance(1_000);
    expect(store.get(HASH)).toBeUndefined();
  });

  it('au-delà de max, le torrent le moins récemment consulté est oublié', () => {
    const store = new PackStore({ max: 2, now: clock().now });
    const third = '1111111111111111111111111111111111111111';
    store.learn(HASH, SERIES_PACK);
    store.learn(OTHER, SERIES_PACK);
    expect(store.get(HASH)).toBeDefined(); // HASH devient le plus récent
    store.learn(third, SERIES_PACK);
    expect(store.get(OTHER)).toBeUndefined();
    expect(store.get(HASH)).toBeDefined();
    expect(store.get(third)).toBeDefined();
  });
});

describe('PackStore : sérialisation JSON', () => {
  it('JSON.stringify puis fromJSON restaure les packs, les fichiers et la durée restante', () => {
    const t = clock();
    const store = new PackStore({ now: t.now });
    store.learn(HASH, SERIES_PACK);
    t.advance(DAY);
    store.learn(OTHER, [{ idx: 0, name: 'Autre.S03E04.mkv', size: 42 }]);

    const json = JSON.stringify(store);
    expect(json).not.toContain('expiresAt');
    const restored = PackStore.fromJSON(JSON.parse(json), { now: t.now });

    expect(restored.get(HASH)).toEqual(SERIES_PACK);
    expect(restored.findEpisode(OTHER, 3, 4)).toEqual({ idx: 0, name: 'Autre.S03E04.mkv', size: 42 });
    // À l export, HASH avait 29 jours restants (30 jours moins 1) et OTHER 30 jours.
    t.advance(28 * DAY);
    expect(restored.get(HASH)).toBeDefined();
    t.advance(DAY);
    expect(restored.get(HASH)).toBeUndefined();
    expect(restored.get(OTHER)).toBeDefined();
  });

  it('fromJSON ignore les données invalides sans lever d erreur', () => {
    const t = clock();
    const data = {
      version: 1,
      packs: [
        { infoHash: 'pas-un-hash', remainingMs: 1000, files: SERIES_PACK },
        { infoHash: HASH, remainingMs: 0, files: SERIES_PACK },
        { infoHash: HASH, remainingMs: Number.POSITIVE_INFINITY, files: SERIES_PACK },
        { infoHash: HASH, remainingMs: 1000, files: 'pas un tableau' },
        { infoHash: OTHER, remainingMs: 1000, files: [{ idx: 'x', name: 'a', size: 1 }] },
        null,
        42,
      ],
    };
    const store = PackStore.fromJSON(data, { now: t.now });
    expect(store.get(HASH)).toBeUndefined();
    expect(store.get(OTHER)).toBeUndefined();
    expect(store.toJSON().packs).toEqual([]);
  });

  it('fromJSON refuse les versions inconnues et les valeurs non objet', () => {
    expect(PackStore.fromJSON(null).toJSON().packs).toEqual([]);
    expect(PackStore.fromJSON('texte').toJSON().packs).toEqual([]);
    expect(PackStore.fromJSON({ version: 2, packs: [] }).toJSON().packs).toEqual([]);
    expect(PackStore.fromJSON({ version: 1, packs: 'x' }).toJSON().packs).toEqual([]);
  });

  it('fromJSON respecte le plafond max de la nouvelle instance', () => {
    const t = clock();
    const store = new PackStore({ now: t.now });
    store.learn(HASH, SERIES_PACK);
    store.learn(OTHER, SERIES_PACK);
    const restored = PackStore.fromJSON(JSON.parse(JSON.stringify(store)), { max: 1, now: t.now });
    expect(restored.get(HASH)).toBeUndefined();
    expect(restored.get(OTHER)).toBeDefined();
  });
});
