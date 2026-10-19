import { describe, expect, it } from 'vitest';
import {
  FALLBACK_HANDLE_NAME,
  generateHandleTag,
  generatePid,
  HANDLE_TAG_ALPHABET,
  handleNameFromProfileName,
  normalizeHandleName,
  parseHandle,
  PID_ALPHABET,
  type RandomBytes,
} from '../src/user/social-handles.js';

/** Générateur scripté : un octet par appel, dans l'ordre. Épuisé, il échoue au lieu de boucler. */
function scripted(values: number[]): RandomBytes {
  const queue = [...values];
  return (bytes) => {
    const next = queue.shift();
    if (next === undefined) throw new Error('suite aléatoire épuisée');
    bytes[0] = next;
  };
}

const TAG_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;
const PID_PATTERN = /^[A-Z2-7]{16}$/;

describe('alphabets et tirages', () => {
  it('alphabet des tags : 31 symboles, sans 0 O 1 I L', () => {
    expect(HANDLE_TAG_ALPHABET).toHaveLength(31);
    for (const forbidden of ['0', 'O', '1', 'I', 'L']) expect(HANDLE_TAG_ALPHABET).not.toContain(forbidden);
  });

  it('tag : quatre symboles de l’alphabet ; les octets hors plage sont rejetés (pas de biais)', () => {
    // 248 à 255 ne sont pas des multiples de 31 : rejetés. 0 1 2 3 donnent « 2345 ».
    expect(generateHandleTag(scripted([248, 250, 255, 0, 1, 2, 3]))).toBe('2345');
  });

  it('pid : seize symboles base32', () => {
    expect(generatePid(scripted(Array.from({ length: 16 }, () => 31)))).toBe('7777777777777777');
    expect(PID_ALPHABET).toHaveLength(32);
  });

  it('tirages réels : tags bien formés, presque tous distincts', () => {
    const tags = Array.from({ length: 200 }, () => generateHandleTag());
    for (const tag of tags) expect(tag).toMatch(TAG_PATTERN);
    expect(new Set(tags).size).toBeGreaterThan(195);
    for (const pid of Array.from({ length: 20 }, () => generatePid())) expect(pid).toMatch(PID_PATTERN);
  });
});

describe('lecture d’un handle « Nom#TAG »', () => {
  it('casse indifférente : le tag passe en majuscules, la clé de nom est en minuscules', () => {
    expect(parseHandle('greg#a7k2')).toEqual({ name: 'greg', key: 'greg', tag: 'A7K2', full: 'greg#A7K2' });
    expect(parseHandle('Greg#A7K2')?.key).toBe('greg');
  });

  it('rejette tout caractère hors alphabet du tag (y compris en minuscules)', () => {
    for (const forbidden of ['0', '1', 'O', 'I', 'L', 'o', 'i', 'l']) {
      expect(parseHandle(`Greg#A7K${forbidden}`)).toBeNull();
    }
    // Caractère non ASCII qui se mettrait en majuscule dans l'alphabet : rejeté avant la mise en majuscules.
    expect(parseHandle('Greg#A7Kſ')).toBeNull();
  });

  it('rejette la mauvaise longueur de tag, la forme et les caractères interdits dans le nom', () => {
    expect(parseHandle('Greg#A7K')).toBeNull();
    expect(parseHandle('Greg#A7K22')).toBeNull();
    expect(parseHandle('Greg##A7K2')).toBeNull();
    expect(parseHandle('Greg A7K2')).toBeNull();
    expect(parseHandle('Gr@g#A7K2')).toBeNull();
    expect(parseHandle('Greg#A7K2#')).toBeNull();
  });

  it('nom de 2 à 20 caractères : bornes acceptées, hors bornes rejetées', () => {
    expect(parseHandle('G#A7K2')).toBeNull();
    expect(parseHandle('Ab#A7K2')?.name).toBe('Ab');
    expect(parseHandle(`${'A'.repeat(20)}#A7K2`)).not.toBeNull();
    expect(parseHandle(`${'A'.repeat(21)}#A7K2`)).toBeNull();
  });

  it('nom Unicode, chiffres, espace, tiret et tiret bas acceptés ; espaces de bord ignorés', () => {
    expect(parseHandle('Élodie-Ana_2#B2C3')?.full).toBe('Élodie-Ana_2#B2C3');
    expect(parseHandle('Zoë#B2C3')?.name).toBe('Zoë');
    expect(parseHandle('Jean Paul#B2C3')?.name).toBe('Jean Paul');
    expect(parseHandle('  Greg#A7K2  ')?.full).toBe('Greg#A7K2');
  });
});

describe('normalisation des noms', () => {
  it('clé d’unicité : forme NFC, espaces réduits, minuscules', () => {
    expect(normalizeHandleName('  Élodie   ANA ')).toBe('élodie ana');
    expect(normalizeHandleName('Zoë')).toBe(normalizeHandleName('Zoë'));
  });

  it('nom de handle dérivé du nom du profil : caractères hors liste retirés, 20 caractères au plus', () => {
    expect(handleNameFromProfileName('Greg!!')).toBe('Greg');
    expect(handleNameFromProfileName('  Greg   Junior  ')).toBe('Greg Junior');
    expect(handleNameFromProfileName('Marie-Christine de la Fontaine')).toBe('Marie-Christine de l');
  });

  it('nom sans caractère admis : repli sur le nom par défaut', () => {
    expect(handleNameFromProfileName('???')).toBe(FALLBACK_HANDLE_NAME);
    expect(handleNameFromProfileName('!')).toBe(FALLBACK_HANDLE_NAME);
  });
});
