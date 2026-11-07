import { describe, expect, it } from 'vitest';
import { scrubSecrets } from '../src/routes/test.js';
import { maskSecrets } from '../src/sources/http.js';

const KEY = 'k/ey+123456';
const ENCODED = encodeURIComponent(KEY);
const BASE64 = Buffer.from(KEY, 'utf8').toString('base64');
const BASE64URL = Buffer.from(KEY, 'utf8').toString('base64url');

describe('scrubSecrets : formes brute, URL-encodée et base64', () => {
  it('masque la valeur brute', () => {
    expect(scrubSecrets(`refus pour ${KEY} ici`, [KEY])).toBe('refus pour *** ici');
  });

  it('masque la forme URL-encodée (encodeURIComponent)', () => {
    expect(scrubSecrets(`url ?apikey=${ENCODED} erreur`, [KEY])).toBe('url ?apikey=*** erreur');
  });

  it('masque la forme base64 et base64url', () => {
    expect(scrubSecrets(`b64 ${BASE64} et ${BASE64URL}`, [KEY])).toBe('b64 *** et ***');
  });

  it('ignore les secrets vides', () => {
    expect(scrubSecrets('message', [''])).toBe('message');
  });

  it('secret court (< 6 caractères) : jamais masqué, message générique s il le contient', () => {
    expect(scrubSecrets('clé abc invalide', ['abc'])).toBe('erreur inattendue');
    expect(scrubSecrets('aucun secret ici', ['abc'])).toBe('aucun secret ici');
  });

  it('secret court contenu sous forme base64 : message générique', () => {
    const short = 'ab';
    const encoded = Buffer.from(short, 'utf8').toString('base64');
    expect(scrubSecrets(`token ${encoded}`, [short])).toBe('erreur inattendue');
  });

  it('maskSecrets masque tous les secrets longs d un message', () => {
    expect(maskSecrets(`${KEY} / ${BASE64}`, [KEY, 'autre-secret-long'])).toBe('*** / ***');
  });
});
