import { describe, expect, it } from 'vitest';
import { notYetDigitalOf, notYetDigitalText } from '../src/data/sources';
import { ADULT_ROWS, rowById } from '../src/data/rows';

/** Top 10 (rangées serveur) et film pas encore disponible en numérique : champs de réponse et message affiché. */

describe('film pas encore disponible en numérique : réponse lastAddon', () => {
  it('notYetDigital vrai avec la date de sortie numérique annoncée', () => {
    expect(notYetDigitalOf({ notYetDigital: true, digitalDate: '2026-11-18' })).toEqual({ notYetDigital: true, digitalDate: '2026-11-18' });
  });

  it('sans date valide : seulement notYetDigital', () => {
    expect(notYetDigitalOf({ notYetDigital: true })).toEqual({ notYetDigital: true });
    expect(notYetDigitalOf({ notYetDigital: true, digitalDate: '18/11/2026' })).toEqual({ notYetDigital: true });
  });

  it('réponse normale ou valeur non booléenne : aucun champ ajouté', () => {
    expect(notYetDigitalOf({})).toEqual({});
    expect(notYetDigitalOf({ notYetDigital: 'oui', digitalDate: '2026-11-18' })).toEqual({});
  });
});

describe('film pas encore disponible en numérique : message', () => {
  it('avec la date prévue', () => {
    const text = notYetDigitalText('2026-11-18');
    expect(text).toContain('Pas encore disponible en streaming');
    expect(text).toContain('sortie numérique prévue le 18 novembre 2026');
  });

  it('sans date connue', () => {
    expect(notYetDigitalText(undefined)).toBe('Pas encore disponible en streaming.');
  });
});

describe('Top 10 : rangées servies par le serveur', () => {
  it('Top 10 films et séries : fetch top10 (plus de contrôle par tuile), 10 titres', () => {
    const films = rowById('top-films');
    const series = rowById('top-series');
    expect(films).toMatchObject({ kind: 'top10', minItems: 10, fetch: { k: 'top10', type: 'movie' } });
    expect(series).toMatchObject({ kind: 'top10', minItems: 10, fetch: { k: 'top10', type: 'tv' } });
    expect(ADULT_ROWS.filter((r) => r.kind === 'top10').map((r) => r.id)).toEqual(['top-series', 'top-films']);
  });
});
