// Guide TV (« Ce soir à la TV », « Émissions du moment ») : seulement les chaînes présentes dans le catalogue. Une chaîne
// TNT retirée par le test de santé du serveur (aucun flux qui marche) n'y apparaît plus, même si son numéro existe.
import { describe, expect, it } from 'vitest';
import { mainChannels, type LocalCh } from '../src/data/showsApi';

const ch = (id: string, name: string): LocalCh => ({
  id, name, logo: 'https://logo.example/' + id + '.png', group: '', cat: 'generaliste', source: 'freetv', fast: false, url: 'https://s.example/' + id,
  sig: null, epgId: id, flaky: false,
} as unknown as LocalCh);

describe('guide TV : chaînes lisibles seulement', () => {
  it('un numéro TNT absent du catalogue (W9 retirée) n’est pas ajouté au guide', () => {
    const guide = mainChannels([ch('fr:TF1.fr', 'TF1'), ch('fr:M6.fr', 'M6')], 'FR');
    expect(guide.map((c) => c.name)).toEqual(['TF1', 'M6']);
    expect(guide.every((c) => c.playId)).toBe(true);
    expect(guide.some((c) => c.num === 9)).toBe(false);
  });

  it('chaque entrée garde son numéro et se lit par son identifiant du catalogue', () => {
    const guide = mainChannels([ch('fr:W9.fr', 'W9'), ch('fr:TF1.fr', 'TF1')], 'FR');
    expect(guide).toEqual([
      expect.objectContaining({ name: 'TF1', num: 1, playId: 'fr:TF1.fr' }),
      expect.objectContaining({ name: 'W9', num: 9, playId: 'fr:W9.fr' }),
    ]);
  });
});
