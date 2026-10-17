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
