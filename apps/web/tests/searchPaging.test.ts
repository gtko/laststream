import { describe, expect, it } from 'vitest';
import { batchSize, hasMore, hiddenCount, moreLabel, needsMore, sectionLimit } from '../src/ui/searchPaging.js';

describe('pagination par section de la recherche', () => {
  it('affiche 18 titres par section dans la vue « Tout », 36 dans un filtre unique', () => {
    expect(batchSize('movie', 'all')).toBe(18);
    expect(batchSize('tv', 'all')).toBe(18);
    expect(batchSize('movie', 'movie')).toBe(36);
    expect(batchSize('tv', 'tv')).toBe(36);
  });

  it('affiche 12 personnalités dans la vue « Tout », 24 dans le filtre Personnalités', () => {
    expect(batchSize('people', 'all')).toBe(12);
    expect(batchSize('people', 'people')).toBe(24);
  });

  it('chaque clic sur « Charger plus » ajoute un lot', () => {
    expect(sectionLimit('movie', 'all', 0)).toBe(18);
    expect(sectionLimit('movie', 'all', 1)).toBe(36);
    expect(sectionLimit('movie', 'all', 3)).toBe(72);
    expect(sectionLimit('people', 'people', 2)).toBe(72);
  });

  it('ignore un nombre de lots absent ou négatif', () => {
    expect(sectionLimit('tv', 'all', -2)).toBe(18);
    expect(sectionLimit('tv', 'all', undefined as unknown as number)).toBe(18);
  });

  it('va chercher d’autres pages seulement s’il manque des résultats et que la liste n’est pas finie', () => {
    expect(needsMore(10, 36, false)).toBe(true);
    expect(needsMore(40, 36, false)).toBe(false);
    expect(needsMore(10, 36, true)).toBe(false);
  });

  it('compte les résultats chargés mais masqués', () => {
    expect(hiddenCount(25, 18)).toBe(7);
    expect(hiddenCount(10, 18)).toBe(0);
  });

  it('le bouton disparaît quand tout est affiché et que la liste est finie', () => {
    expect(hasMore(18, 18, true)).toBe(false);
    expect(hasMore(10, 18, true)).toBe(false);
    expect(hasMore(25, 18, true)).toBe(true);
    expect(hasMore(10, 18, false)).toBe(true); // d’autres pages peuvent encore arriver
  });

  it('le libellé indique ce qu’il reste, avec « + » tant que la liste n’est pas finie', () => {
    expect(moreLabel(25, 18, true)).toBe('Charger plus (7 restants)');
    expect(moreLabel(19, 18, true)).toBe('Charger plus (1 restant)');
    expect(moreLabel(25, 18, false)).toBe('Charger plus (7+ restants)');
    expect(moreLabel(10, 18, false)).toBe('Charger plus');
    expect(moreLabel(18, 18, true)).toBe('');
  });
});
