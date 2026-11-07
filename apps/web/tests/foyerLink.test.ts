import { describe, expect, it } from 'vitest';
import { foyerLink, parseFoyerToken } from '../src/data/foyerLink';

const TOKEN = 'aZ0_-'.repeat(8) + 'aZ0_'; // 44 caractères base64url, comme un jeton de 32 octets

describe('foyerLink : lien d’invitation au foyer', () => {
  it('ajoute /#/foyer/<jeton> à l’origine', () => {
    expect(foyerLink('https://laststream.example', TOKEN)).toBe('https://laststream.example/#/foyer/' + TOKEN);
  });

  it('retire les barres finales de la base, sans en produire deux', () => {
    expect(foyerLink('https://laststream.example///', TOKEN)).toBe('https://laststream.example/#/foyer/' + TOKEN);
    expect(foyerLink('http://192.168.1.10:7000/', TOKEN)).toBe('http://192.168.1.10:7000/#/foyer/' + TOKEN);
  });

  it('le lien produit est relu à l’identique par parseFoyerToken', () => {
    const link = foyerLink('https://laststream.example/', TOKEN);
    expect(parseFoyerToken(new URL(link).hash)).toBe(TOKEN);
  });
});

describe('parseFoyerToken : jeton d’une adresse #/foyer/<jeton>', () => {
  it('accepte un jeton base64url de 20 à 64 caractères', () => {
    expect(parseFoyerToken('#/foyer/' + 'a'.repeat(20))).toBe('a'.repeat(20));
    expect(parseFoyerToken('#/foyer/' + 'B-_9'.repeat(16))).toBe('B-_9'.repeat(16));
    expect(parseFoyerToken('#/foyer/' + TOKEN)).toBe(TOKEN);
  });

  it('accepte une barre finale', () => {
    expect(parseFoyerToken('#/foyer/' + TOKEN + '/')).toBe(TOKEN);
  });

  it('refuse les jetons trop courts ou trop longs', () => {
    expect(parseFoyerToken('#/foyer/' + 'a'.repeat(19))).toBeNull();
    expect(parseFoyerToken('#/foyer/' + 'a'.repeat(65))).toBeNull();
    expect(parseFoyerToken('#/foyer/')).toBeNull();
  });

  it('refuse les caractères hors base64url (espaces, +, /, =, %, points)', () => {
    for (const bad of ['a+'.repeat(12), 'a/'.repeat(12), 'a='.repeat(12), 'a%20'.repeat(6), 'a.'.repeat(12), 'a b'.repeat(8)]) {
      expect(parseFoyerToken('#/foyer/' + bad)).toBeNull();
    }
  });

  it('refuse les autres routes, les préfixes et les sous-chemins', () => {
    expect(parseFoyerToken('#/party/join/' + TOKEN)).toBeNull();
    expect(parseFoyerToken('#/reset/' + TOKEN)).toBeNull();
    expect(parseFoyerToken('#/foyer/' + TOKEN + '/extra')).toBeNull();
    expect(parseFoyerToken('#/foyer/' + TOKEN + '?x=1')).toBeNull();
    expect(parseFoyerToken('/foyer/' + TOKEN)).toBeNull();
    expect(parseFoyerToken('')).toBeNull();
  });
});
