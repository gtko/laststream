import { describe, expect, it } from 'vitest';
import { langCode3, nationalEntry, normText, rankChannels, sameLang } from '../src/data/tvRank';

type Ch = { id: string; name: string; epgId: string; cat: string; source: string; fast: boolean; flaky: boolean; num?: number | null; categories?: Array<{ id: string }> };
const c = (name: string, extra: Partial<Ch> = {}): Ch => ({ id: 'fr:' + name.replace(/\W/g, '') + '.fr', name, epgId: name.replace(/\W/g, '') + '.fr', cat: 'Autre', source: 'iptvorg', fast: false, flaky: false, ...extra });

describe('classement des chaînes', () => {
  it('normalise accents, casse et ponctuation', () => {
    expect(normText('L’Équipe')).toBe('lequipe');
    expect(normText('Canal+')).toBe('canalplus');
    expect(normText('  BFM TV ')).toBe('bfmtv');
  });

  it('convertit les codes de langue vers ISO 639-3', () => {
    expect(langCode3('fr')).toBe('fra');
    expect(langCode3('fr-FR')).toBe('fra');
    expect(langCode3('FRA')).toBe('fra');
    expect(langCode3('de')).toBe('deu');
    expect(langCode3('')).toBe('');
    expect(sameLang('fr', 'fra')).toBe(true);
    expect(sameLang('fr', 'deu')).toBe(false);
  });

  it('place la TNT dans l’ordre officiel avec son numéro, puis France 3 régionales, puis le reste', () => {
    const list = [
      c('4 Afghanistan'), c('4 Music'), c('Allociné', { cat: 'Divertissement' }), c('BFM TV', { cat: 'Actualités' }), c('C8'), c('CNews', { cat: 'Actualités' }),
      c('France 3 Alsace'), c('France 3'), c('France 5'), c('L’Equipe', { id: 'fr:LEquipe.fr', epgId: 'LEquipe.fr', cat: 'Sport' }), c('M6'), c('TF1'), c('TMC'),
      c('Canal+', { id: 'fr:CanalPlus.fr', epgId: 'CanalPlus.fr' }), c('Franceinfo'), c('RMC Découverte'),
      c('Zoo', { flaky: true }),
    ];
    const out = rankChannels(list, 'FR');
    expect(out.slice(0, 13).map((x) => x.name)).toEqual(['TF1', 'France 3', 'Canal+', 'France 5', 'M6', 'C8', 'TMC', 'BFM TV', 'CNews', 'L’Equipe', 'RMC Découverte', 'Franceinfo', 'France 3 Alsace']);
    const nums = out.filter((x) => x.num).map((x) => x.num);
    expect(nums).toEqual([1, 3, 4, 5, 6, 8, 10, 15, 16, 21, 24, 27]);
    expect(out[out.length - 1].name).toBe('Zoo'); // instable : en dernier
    expect(out.findIndex((x) => x.name === 'Allociné')).toBeLessThan(out.findIndex((x) => x.name === '4 Afghanistan'));
  });

  it('un doublon instable d’une chaîne nationale ne prend pas le numéro', () => {
    const out = rankChannels([c('Arte', { id: 'fr:ARTEFrench.fr', epgId: 'ARTEFrench.fr', flaky: true }), c('arte', { id: 'fr:arte.fr', epgId: 'arte.fr' })], 'FR');
    expect(out[0].id).toBe('fr:arte.fr');
    expect(out[0].num).toBe(7);
    expect(out[1].num).toBeNull();
  });

  it('pays sans table : popularité de la catégorie, instables en dernier', () => {
    const out = rankChannels([c('Musique X', { categories: [{ id: 'musique' }] }), c('Info Y', { categories: [{ id: 'actualites' }] }), c('Gen Z', { categories: [{ id: 'generaliste' }] })], 'ES');
    expect(out.map((x) => x.name)).toEqual(['Gen Z', 'Info Y', 'Musique X']);
    expect(nationalEntry(out[0], 'ES')).toBeNull();
  });
});
