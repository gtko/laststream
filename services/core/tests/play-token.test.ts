import { createHmac, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeCopiesToken, encodeCopiesToken, type PlayCopy } from '../src/play/token.js';

const SECRET = 'x'.repeat(40);
const OTHER_SECRET = 'y'.repeat(40);
const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

const COPIES: PlayCopy[] = [
  { infoHash: HASH_A, fileIdx: 2, filename: 'Show.S01E05.1080p.mkv', size: 1_500_000_000 },
  { url: 'https://cdn.example/direct/file.mkv', filename: 'Show.S01E05.720p.mkv' },
  { infoHash: HASH_B },
];

/** Remplace le premier caractère par un autre caractère base64url valide. */
function swapFirstChar(token: string): string {
  return (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
}

/**
 * Scelle un corps JSON brut comme encodeCopiesToken (même contexte HKDF, même tronquage à 16 octets).
 * Sert à fabriquer des jetons « anciens » ou mal formés, que l'encodeur actuel ne produirait pas.
 */
function sealRaw(body: unknown, secret: string): string {
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), 'lastaddon/play/copies/v1', 32));
  const payload = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const tag = createHmac('sha256', key).update(payload, 'utf8').digest().subarray(0, 16).toString('base64url');
  return `${payload}.${tag}`;
}

const GUID = 'release-guid-42';
const HOSTER_URL = 'https://1fichier.example/x7Qa';
/** Copies étendues : torrent privé (guid, p) et lien d'hébergeur (kind hoster). */
const EXTENDED: PlayCopy[] = [
  { infoHash: HASH_A, fileIdx: 3, guid: GUID, privateTorrent: true, filename: 'Show.S01E05.1080p.mkv', size: 1_500_000_000 },
  { url: HOSTER_URL, kind: 'hoster', filename: 'Show.S01E05.720p.mkv', size: 900_000_000 },
];

describe('encodeCopiesToken / decodeCopiesToken', () => {
  it('fait un aller-retour fidèle, avec saison et épisode', () => {
    const token = encodeCopiesToken(COPIES, { secret: SECRET, season: 1, episode: 5 });
    const decoded = decodeCopiesToken(token, SECRET);
    expect(decoded).not.toBeNull();
    expect(decoded?.copies).toEqual(COPIES);
    expect(decoded?.season).toBe(1);
    expect(decoded?.episode).toBe(5);
  });

  it('omet saison et épisode pour un film', () => {
    const token = encodeCopiesToken(COPIES, { secret: SECRET });
    const decoded = decodeCopiesToken(token, SECRET);
    expect(decoded?.copies).toEqual(COPIES);
    expect(decoded?.season).toBeUndefined();
    expect(decoded?.episode).toBeUndefined();
  });

  it('rejette un jeton dont le contenu a été altéré', () => {
    const token = encodeCopiesToken(COPIES, { secret: SECRET, season: 1, episode: 5 });
    expect(decodeCopiesToken(swapFirstChar(token), SECRET)).toBeNull();

    // Premier caractère de la signature : ses 6 bits sont des données (le dernier contient du remplissage).
    const dot = token.indexOf('.');
    expect(token.length - dot - 1).toBe(22);
    const firstSigChar = token[dot + 1] === 'A' ? 'B' : 'A';
    const tamperedSignature = `${token.slice(0, dot + 1)}${firstSigChar}${token.slice(dot + 2)}`;
    expect(decodeCopiesToken(tamperedSignature, SECRET)).toBeNull();
  });

  it('rejette un jeton signé avec un autre secret', () => {
    const token = encodeCopiesToken(COPIES, { secret: SECRET });
    expect(decodeCopiesToken(token, OTHER_SECRET)).toBeNull();
  });

  it('tronque à maxCopies en gardant l ordre (défaut : 8)', () => {
    const many: PlayCopy[] = Array.from({ length: 12 }, (_, index) => ({ infoHash: HASH_A, fileIdx: index }));
    const defaulted = decodeCopiesToken(encodeCopiesToken(many, { secret: SECRET }), SECRET);
    expect(defaulted?.copies).toHaveLength(8);
    expect(defaulted?.copies.map((copy) => copy.fileIdx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    const three = decodeCopiesToken(encodeCopiesToken(many, { secret: SECRET, maxCopies: 3 }), SECRET);
    expect(three?.copies.map((copy) => copy.fileIdx)).toEqual([0, 1, 2]);
  });

  it('retire les dernières copies quand le jeton dépasse 4 Ko, sans jamais dépasser la limite', () => {
    const longUrl = (index: number): string => `https://cdn.example/${index}/${'p'.repeat(1000)}`;
    const heavy: PlayCopy[] = Array.from({ length: 6 }, (_, index) => ({ url: longUrl(index) }));
    const token = encodeCopiesToken(heavy, { secret: SECRET });
    expect(token.length).toBeLessThanOrEqual(4096);
    const decoded = decodeCopiesToken(token, SECRET);
    expect(decoded?.copies.length).toBeGreaterThanOrEqual(1);
    expect(decoded?.copies.length).toBeLessThan(heavy.length);
    expect(decoded?.copies).toEqual(heavy.slice(0, decoded?.copies.length));
  });

  it('écarte les copies inutilisables et lève une erreur si aucune ne reste', () => {
    const token = encodeCopiesToken([{ filename: 'sans-source.mkv' }, { infoHash: HASH_A }], { secret: SECRET });
    expect(decodeCopiesToken(token, SECRET)?.copies).toEqual([{ infoHash: HASH_A }]);
    expect(() => encodeCopiesToken([{ filename: 'sans-source.mkv' }], { secret: SECRET })).toThrow(RangeError);
  });

  it('refuse les paramètres invalides à l encodage', () => {
    expect(() => encodeCopiesToken(COPIES, { secret: SECRET, maxCopies: 0 })).toThrow(RangeError);
    expect(() => encodeCopiesToken(COPIES, { secret: SECRET, season: -1 })).toThrow(RangeError);
    expect(() => encodeCopiesToken(COPIES, { secret: '' })).toThrow(RangeError);
  });

  it('renvoie null pour un jeton trop long (plus de 4 Ko)', () => {
    expect(decodeCopiesToken('a'.repeat(4097), SECRET)).toBeNull();
  });

  it('renvoie null pour un jeton malformé', () => {
    expect(decodeCopiesToken('', SECRET)).toBeNull();
    expect(decodeCopiesToken('abc', SECRET)).toBeNull();
    expect(decodeCopiesToken('a.b.c', SECRET)).toBeNull();
    expect(decodeCopiesToken('!!.!!', SECRET)).toBeNull();
    expect(decodeCopiesToken('.', SECRET)).toBeNull();
  });
});

describe('extensions du jeton : guid, hébergeur, torrent privé, date de sortie, âge', () => {
  it('fait un aller-retour fidèle des copies étendues, avec date de sortie, âge, saison et épisode', () => {
    const token = encodeCopiesToken(EXTENDED, { secret: SECRET, season: 1, episode: 5, releasedAt: '2024-03-15', ageFr: 12 });
    const decoded = decodeCopiesToken(token, SECRET);
    expect(decoded?.copies).toEqual(EXTENDED);
    expect(decoded?.releasedAt).toBe('2024-03-15');
    expect(decoded?.ageFr).toBe(12);
    expect(decoded?.season).toBe(1);
    expect(decoded?.episode).toBe(5);
  });

  it.each(['2024-03-15', '2024-03-15T20:00:00Z', '2024-03-15T20:00:00.250+02:00'])('accepte la date de sortie %s', (releasedAt) => {
    const decoded = decodeCopiesToken(encodeCopiesToken(EXTENDED, { secret: SECRET, releasedAt }), SECRET);
    expect(decoded?.releasedAt).toBe(releasedAt);
  });

  it('écrit les noms compacts g, k, p (copie) et r, a (jeton), sans les champs absents', () => {
    const token = encodeCopiesToken(EXTENDED, { secret: SECRET, releasedAt: '2024-03-15T20:00:00Z', ageFr: 16 });
    const body = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'));
    expect(body.c[0]).toEqual({ h: HASH_A, i: 3, f: 'Show.S01E05.1080p.mkv', z: 1_500_000_000, g: GUID, p: 1 });
    expect(body.c[1]).toEqual({ u: HOSTER_URL, f: 'Show.S01E05.720p.mkv', z: 900_000_000, k: 'hoster' });
    expect(body.r).toBe('2024-03-15T20:00:00Z');
    expect(body.a).toBe(16);
    expect(body.s).toBeUndefined();
  });

  it('un jeton ancien (sans aucune extension) reste valide', () => {
    const legacy = sealRaw({ c: [{ h: HASH_A, i: 2, f: 'film.mkv', z: 10 }], s: 1, e: 5 }, SECRET);
    expect(decodeCopiesToken(legacy, SECRET)).toEqual({
      copies: [{ infoHash: HASH_A, fileIdx: 2, filename: 'film.mkv', size: 10 }],
      season: 1,
      episode: 5,
    });
  });

  it('tient dans 4 Ko avec 8 copies étendues, date et âge compris, et les garde toutes', () => {
    const longGuid = (index: number): string => `release-${index}-${'g'.repeat(90)}`;
    const copies: PlayCopy[] = Array.from({ length: 8 }, (_, index) =>
      index % 2 === 0
        ? {
            infoHash: HASH_B,
            fileIdx: index,
            guid: longGuid(index),
            privateTorrent: true,
            filename: `Show.S01E0${index}.2160p.WEB-DL.mkv`,
            size: 2_000_000_000,
          }
        : {
            url: `https://hoster${index}.example/file/${'x'.repeat(60)}`,
            kind: 'hoster',
            filename: `Show.S01E0${index}.1080p.mkv`,
            size: 1_000_000_000,
          },
    );
    const token = encodeCopiesToken(copies, { secret: SECRET, season: 1, episode: 1, releasedAt: '2024-03-15', ageFr: 18 });
    expect(token.length).toBeLessThanOrEqual(4096);
    const decoded = decodeCopiesToken(token, SECRET);
    expect(decoded?.copies).toEqual(copies);
    expect(decoded?.releasedAt).toBe('2024-03-15');
    expect(decoded?.ageFr).toBe(18);
  });

  it('écarte les copies étendues mal formées (guid trop long, hébergeur sans URL, kind inconnu, privé sans guid)', () => {
    const token = encodeCopiesToken(
      [
        { infoHash: HASH_A, privateTorrent: true },
        { url: HOSTER_URL, kind: 'hoster' },
        { kind: 'hoster', infoHash: HASH_B },
        { url: 'https://x.example/a', kind: 'autre' as unknown as 'hoster' },
        { infoHash: HASH_B, guid: 'x'.repeat(513), privateTorrent: true },
      ],
      { secret: SECRET },
    );
    expect(decodeCopiesToken(token, SECRET)?.copies).toEqual([{ url: HOSTER_URL, kind: 'hoster' }]);
  });

  it('refuse une date de sortie ou un âge invalides à l encodage', () => {
    expect(() => encodeCopiesToken(COPIES, { secret: SECRET, releasedAt: 'demain' })).toThrow(RangeError);
    expect(() => encodeCopiesToken(COPIES, { secret: SECRET, releasedAt: '2024-13-45x' })).toThrow(RangeError);
    expect(() => encodeCopiesToken(COPIES, { secret: SECRET, ageFr: -1 })).toThrow(RangeError);
    expect(() => encodeCopiesToken(COPIES, { secret: SECRET, ageFr: 100 })).toThrow(RangeError);
    expect(() => encodeCopiesToken(COPIES, { secret: SECRET, ageFr: 12.5 })).toThrow(RangeError);
  });

  it('renvoie null pour un jeton dont la date ou l âge est invalide', () => {
    expect(decodeCopiesToken(sealRaw({ c: [{ h: HASH_A }], r: 'pas-une-date' }, SECRET), SECRET)).toBeNull();
    expect(decodeCopiesToken(sealRaw({ c: [{ h: HASH_A }], a: 'douze' }, SECRET), SECRET)).toBeNull();
    expect(decodeCopiesToken(sealRaw({ c: [{ h: HASH_A }], a: 150 }, SECRET), SECRET)).toBeNull();
  });

  it('renvoie null pour une copie étendue incohérente (k inconnu, hébergeur sans URL, p invalide ou sans guid)', () => {
    expect(decodeCopiesToken(sealRaw({ c: [{ u: HOSTER_URL, k: 'direct' }] }, SECRET), SECRET)).toBeNull();
    expect(decodeCopiesToken(sealRaw({ c: [{ h: HASH_A, k: 'hoster' }] }, SECRET), SECRET)).toBeNull();
    expect(decodeCopiesToken(sealRaw({ c: [{ h: HASH_A, p: 2, g: GUID }] }, SECRET), SECRET)).toBeNull();
    expect(decodeCopiesToken(sealRaw({ c: [{ h: HASH_A, p: 1 }] }, SECRET), SECRET)).toBeNull();
  });
});
