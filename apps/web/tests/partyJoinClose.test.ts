// Invité : codes de fermeture 4xxx du salon (expiré, exclu, pseudo) affichés comme motifs distincts, et jeton retiré de l’adresse.
import { describe, expect, it } from 'vitest';
import { endReasonText, hashWithoutToken } from '../src/party/join';
import { FINAL_CLOSE_CODES } from '../src/party/protocol';

describe('codes de fermeture du salon (invité)', () => {
  it('chaque motif de refus a son code 4xxx définitif, sans reconnexion', () => {
    expect(FINAL_CLOSE_CODES[4001]).toBe('expired');
    expect(FINAL_CLOSE_CODES[4004]).toBe('banned');
    expect(FINAL_CLOSE_CODES[4010]).toBe('full');
    expect(FINAL_CLOSE_CODES[4011]).toBe('name_taken');
    expect(FINAL_CLOSE_CODES[4012]).toBe('name_changed');
  });

  it('chaque motif affiche un message propre (jamais le message générique « Salon fermé »)', () => {
    const reasons = ['expired', 'banned', 'full', 'name_taken', 'name_changed'];
    const texts = reasons.map((r) => endReasonText(r));
    expect(new Set(texts).size).toBe(reasons.length);
    for (const text of texts) expect(text).not.toBe(endReasonText('unknown-reason'));
    expect(endReasonText('expired')).toMatch(/expir|invalide/);
    expect(endReasonText('name_taken')).toMatch(/pseudo/);
  });
});

describe('jeton retiré de l’adresse après connexion', () => {
  it('ne garde que la route du salon ; une autre adresse est rendue telle quelle', () => {
    expect(hashWithoutToken('#/party/join/abcdefghijklmnop?t=eyJhbGciOiJIUzI1NiJ9.sig')).toBe('#/party/join/abcdefghijklmnop');
    expect(hashWithoutToken('#/party/join/abcdefghijklmnop')).toBe('#/party/join/abcdefghijklmnop');
    expect(hashWithoutToken('#/accueil')).toBe('#/accueil');
  });
});
