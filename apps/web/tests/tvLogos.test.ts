// Logos des chaînes : correspondance avec le catalogue (alias, accents, numéros TNT), pastille de repli.
import { describe, expect, it } from 'vitest';
import { badgeOf, buildLogoIndex, cleanName, findLogo, initials, logoKey } from '../src/data/tvLogos';

const L = (n: string) => `https://logos.example/${n}.png`;
const catalog = [
  { id: 'France2.fr', name: 'France 2', logo: L('f2'), epgId: 'France2.fr' },
  { id: 'BFMTV.fr', name: 'BFMTV', logo: L('bfm'), epgId: 'BFMTV.fr' },
  { id: 'LEquipe.fr', name: 'L’Équipe', logo: L('equipe') },
  { id: 'arte', name: 'Arte', logo: L('arte') },
  { id: 'Mezzo.fr', name: 'Mezzo Live HD', logo: L('mezzo') },
  { id: 'nologo', name: 'Sans logo', logo: '' },
];
const idx = buildLogoIndex(catalog);

describe('nom normalisé', () => {
  it('retire qualité, parenthèses, numéro de tête et accents', () => {
    expect(cleanName('2 - France 2 HD (auto)')).toBe('france 2');
    expect(cleanName('M6 (standard)')).toBe('m6');
    expect(cleanName('Chérie 25 UHD')).toBe('cherie 25');
  });
  it('alias : France 2 = France2, BFM TV = BFMTV', () => {
    expect(logoKey('France 2')).toBe(logoKey('France2'));
    expect(logoKey('BFM TV')).toBe(logoKey('BFMTV'));
    expect(logoKey('L’Équipe')).toBe(logoKey('L Equipe HD'));
  });
});

describe('recherche du logo', () => {
  it('garde le logo propre de la chaîne', () => {
    expect(findLogo({ name: 'X', logo: L('own') }, idx)).toBe(L('own'));
  });
  it('trouve le logo du catalogue pour une chaîne de box sans tvg-logo', () => {
    expect(findLogo({ name: 'France 2 HD', logo: '' }, idx)).toBe(L('f2'));
    expect(findLogo({ name: 'BFM TV', logo: '' }, idx)).toBe(L('bfm'));
    expect(findLogo({ name: 'L’Équipe (auto)', logo: '' }, idx)).toBe(L('equipe'));
    expect(findLogo({ name: 'ARTE', logo: '' }, idx)).toBe(L('arte'));
  });
  it('rapproche par identifiant du guide', () => {
    expect(findLogo({ name: 'Chaîne 2', epgId: 'fr:France2.fr', logo: '' }, idx)).toBe(L('f2'));
  });
  it('numéro TNT : nom approchant portant le bon numéro', () => {
    expect(findLogo({ name: 'FR France 2 Direct', num: 2, logo: '' }, idx)).toBe(L('f2'));
    expect(findLogo({ name: 'FR France 2 Direct', num: 9, logo: '' }, idx)).toBe('');
  });
  it('rien de trouvé : chaîne vide (jamais un mauvais logo)', () => {
    expect(findLogo({ name: 'Inconnue TV', logo: '' }, idx)).toBe('');
    expect(findLogo({ name: 'Sans logo', logo: '' }, idx)).toBe('');
    expect(findLogo({ name: 'France 2' }, null)).toBe('');
  });
});

describe('pastille de repli', () => {
  it('initiales et numéro', () => {
    expect(initials('France 2')).toBe('F2');
    expect(initials('RMC Découverte')).toBe('RD');
    expect(initials('TF1')).toBe('TF1');
    expect(initials('FAST Sport 10')).toBe('F10');
    expect(badgeOf({ name: 'Ma chaîne', num: 902 }).num).toBe('902');
  });
  it('jamais vide, couleur stable et propre au nom', () => {
    const a = badgeOf({ name: 'Ma chaîne locale' });
    expect(a.text.length).toBeGreaterThan(0);
    expect(badgeOf({ name: 'Ma chaîne locale' }).bg).toBe(a.bg);
    expect(badgeOf({ name: 'Autre' }).bg).not.toBe(a.bg);
    expect(badgeOf({}).text).toBe('?');
  });
});
