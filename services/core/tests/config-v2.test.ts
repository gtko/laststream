import { describe, expect, it } from 'vitest';
import {
  AGE_LIMIT_VALUES,
  ATMOS_VALUES,
  DEFAULT_QUALITIES,
  DISPLAY_TEMPLATE_VALUES,
  MULTICHANNEL_VALUES,
  PRESET_VALUES,
  QUALITY_VALUES,
  SORT_VALUES,
  UNSUPPORTED_FORMAT_VALUES,
  UNSUPPORTED_MODE_VALUES,
  ConfigValidationError,
  configJsonSchema,
  parseConfig,
} from '../src/config/schema.js';

/** Renvoie les messages de validation, ou une liste vide si la configuration est acceptée. */
function issuesOf(input: unknown): string[] {
  try {
    parseConfig(input);
    return [];
  } catch (err) {
    if (err instanceof ConfigValidationError) return [...err.issues];
    throw err;
  }
}

/** Ancienne configuration (avant la v2) : doit rester valide et inchangée. */
const LEGACY = {
  sources: [{ type: 'torznab', name: 'Indexeur', baseUrl: 'https://indexer.example.com/api', apiKey: 'API-KEY-XYZ' }],
  maxResults: 12,
  excludedTags: ['CAM'],
};

describe('configuration v2 : défauts', () => {
  it('applique les défauts des nouveaux champs sur une configuration vide', () => {
    const config = parseConfig({});
    expect(config.preset).toBeUndefined();
    expect(config.filters).toEqual({
      ageLimit: 'none',
      hideUnreleased: true,
      qualities: ['REMUX', 'BluRay', 'WEB-DL', 'WEBRip', 'HDTV', 'DVDRip', 'unknown'],
      bitrate: {},
      allow3d: false,
      bannedWords: [],
      preferredWords: [],
      directVerifiedOnly: false,
    });
    expect(config.filters.maxPerResolution).toBeUndefined();
    expect(config.audio).toEqual({
      multichannel: 'none',
      atmos: 'none',
      unsupportedFormats: [],
      unsupportedMode: 'deprioritize',
      verifiedLanguagesOnly: false,
      probeTopN: 5,
    });
    expect(config.sort).toBe('default');
    expect(config.display).toEqual({ template: 'detaille' });
    expect(config.play).toEqual({ budgetMs: 12000 });
  });

  it('garde une ancienne configuration valide et ses valeurs', () => {
    const config = parseConfig(LEGACY);
    expect(config.maxResults).toBe(12);
    expect(config.excludedTags).toEqual(['CAM']);
    expect(config.filters.hideUnreleased).toBe(true);
    expect(config.audio.probeTopN).toBe(5);
  });

  it('accepte des valeurs explicites valides et supprime les espaces des mots', () => {
    const config = parseConfig({
      preset: 'zen',
      filters: {
        ageLimit: 16,
        hideUnreleased: false,
        qualities: ['BluRay', 'CAM'],
        bitrate: { minMbps: 5, maxMbps: 5 },
        maxPerResolution: { '1080p': 3 },
        allow3d: true,
        bannedWords: ['  cam  '],
        preferredWords: ['VFF'],
        directVerifiedOnly: true,
      },
      audio: {
        multichannel: 'require5_1',
        atmos: 'prefer',
        unsupportedFormats: ['TrueHD', 'Atmos'],
        unsupportedMode: 'exclude',
        verifiedLanguagesOnly: true,
        probeTopN: 0,
      },
      sort: 'heaviest',
      display: { template: 'netflix' },
      play: { budgetMs: 60000 },
    });
    expect(config.preset).toBe('zen');
    expect(config.filters.ageLimit).toBe(16);
    expect(config.filters.qualities).toEqual(['BluRay', 'CAM']);
    expect(config.filters.bannedWords).toEqual(['cam']);
    expect(config.filters.maxPerResolution).toEqual({ '1080p': 3 });
    expect(config.audio.unsupportedFormats).toEqual(['TrueHD', 'Atmos']);
    expect(config.audio.probeTopN).toBe(0);
    expect(config.sort).toBe('heaviest');
    expect(config.display.template).toBe('netflix');
    expect(config.play.budgetMs).toBe(60000);
  });

  it('accepte chaque préréglage et chaque valeur d’enum documentée', () => {
    for (const preset of PRESET_VALUES) expect(issuesOf({ preset })).toEqual([]);
    for (const ageLimit of AGE_LIMIT_VALUES) expect(issuesOf({ filters: { ageLimit } })).toEqual([]);
    for (const multichannel of MULTICHANNEL_VALUES) expect(issuesOf({ audio: { multichannel } })).toEqual([]);
    for (const atmos of ATMOS_VALUES) expect(issuesOf({ audio: { atmos } })).toEqual([]);
    for (const unsupportedMode of UNSUPPORTED_MODE_VALUES) expect(issuesOf({ audio: { unsupportedMode } })).toEqual([]);
    for (const sort of SORT_VALUES) expect(issuesOf({ sort })).toEqual([]);
    for (const template of DISPLAY_TEMPLATE_VALUES) expect(issuesOf({ display: { template } })).toEqual([]);
    expect(issuesOf({ audio: { unsupportedFormats: [...UNSUPPORTED_FORMAT_VALUES] } })).toEqual([]);
  });
});

describe('configuration v2 : rejets', () => {
  it('rejette un préréglage inconnu', () => {
    expect(issuesOf({ preset: 'inconnu' }).some((i) => i.startsWith('preset'))).toBe(true);
  });

  it('rejette une limite d’âge hors de 10, 12, 16, 18 ou none', () => {
    expect(issuesOf({ filters: { ageLimit: 13 } }).some((i) => i.startsWith('filters.ageLimit'))).toBe(true);
    expect(issuesOf({ filters: { ageLimit: 'adulte' } }).some((i) => i.startsWith('filters.ageLimit'))).toBe(true);
  });

  it('rejette une qualité inconnue', () => {
    expect(issuesOf({ filters: { qualities: ['4K'] } }).some((i) => i.startsWith('filters.qualities.0'))).toBe(true);
  });

  it('rejette un débit négatif et un débit min > max', () => {
    expect(issuesOf({ filters: { bitrate: { minMbps: -1 } } }).some((i) => i.startsWith('filters.bitrate.minMbps'))).toBe(
      true,
    );
    expect(issuesOf({ filters: { bitrate: { minMbps: 10, maxMbps: 2 } } })).toContain(
      'filters.bitrate: minMbps must be <= maxMbps',
    );
  });

  it('rejette un maximum par résolution invalide', () => {
    expect(issuesOf({ filters: { maxPerResolution: { '1080p': 0 } } }).length).toBeGreaterThan(0);
    expect(issuesOf({ filters: { maxPerResolution: { '4K': 1 } } }).length).toBeGreaterThan(0);
  });

  it('rejette un mot vide dans les listes de mots', () => {
    expect(issuesOf({ filters: { bannedWords: ['   '] } }).some((i) => i.startsWith('filters.bannedWords'))).toBe(true);
    expect(issuesOf({ filters: { preferredWords: [''] } }).some((i) => i.startsWith('filters.preferredWords'))).toBe(true);
  });

  it('rejette une valeur audio inconnue', () => {
    expect(issuesOf({ audio: { multichannel: 'prefer6_1' } }).some((i) => i.startsWith('audio.multichannel'))).toBe(true);
    expect(issuesOf({ audio: { atmos: 'peut-etre' } }).some((i) => i.startsWith('audio.atmos'))).toBe(true);
    expect(issuesOf({ audio: { unsupportedFormats: ['DTS'] } }).some((i) => i.startsWith('audio.unsupportedFormats'))).toBe(
      true,
    );
    expect(issuesOf({ audio: { unsupportedMode: 'cacher' } }).some((i) => i.startsWith('audio.unsupportedMode'))).toBe(
      true,
    );
  });

  it('rejette un nombre de sondes hors de 0..20', () => {
    expect(issuesOf({ audio: { probeTopN: -1 } }).some((i) => i.startsWith('audio.probeTopN'))).toBe(true);
    expect(issuesOf({ audio: { probeTopN: 21 } }).some((i) => i.startsWith('audio.probeTopN'))).toBe(true);
    expect(issuesOf({ audio: { probeTopN: 2.5 } }).some((i) => i.startsWith('audio.probeTopN'))).toBe(true);
  });

  it('rejette un tri ou un modèle d’affichage inconnu', () => {
    expect(issuesOf({ sort: 'aleatoire' }).some((i) => i.startsWith('sort'))).toBe(true);
    expect(issuesOf({ display: { template: 'classique' } }).some((i) => i.startsWith('display.template'))).toBe(true);
  });

  it('rejette un budget de lecture hors de 1000..60000 ms', () => {
    expect(issuesOf({ play: { budgetMs: 999 } }).some((i) => i.startsWith('play.budgetMs'))).toBe(true);
    expect(issuesOf({ play: { budgetMs: 60001 } }).some((i) => i.startsWith('play.budgetMs'))).toBe(true);
    expect(issuesOf({ play: { budgetMs: 1500.5 } }).some((i) => i.startsWith('play.budgetMs'))).toBe(true);
  });
});

describe('configuration v2 : constantes exportées', () => {
  it('QUALITY_VALUES couvre toutes les sources, DEFAULT_QUALITIES exclut CAM, TS et SCR', () => {
    expect([...QUALITY_VALUES].sort()).toEqual(
      ['BluRay', 'CAM', 'DVDRip', 'HDTV', 'REMUX', 'SCR', 'TS', 'WEB-DL', 'WEBRip', 'unknown'].sort(),
    );
    expect(DEFAULT_QUALITIES).toHaveLength(7);
    expect(DEFAULT_QUALITIES).not.toContain('CAM');
    expect(DEFAULT_QUALITIES).not.toContain('TS');
    expect(DEFAULT_QUALITIES).not.toContain('SCR');
    expect(DEFAULT_QUALITIES).toContain('unknown');
  });

  it('expose les valeurs des enums dans l’ordre documenté', () => {
    expect(PRESET_VALUES).toEqual(['essentiel', 'zen', 'cinephile', 'nomade']);
    expect(AGE_LIMIT_VALUES).toEqual(['none', 10, 12, 16, 18]);
    expect(MULTICHANNEL_VALUES).toEqual(['none', 'prefer5_1', 'require5_1', 'prefer7_1', 'require7_1']);
    expect(ATMOS_VALUES).toEqual(['none', 'prefer', 'require']);
    expect(UNSUPPORTED_FORMAT_VALUES).toEqual(['DTS-HD', 'TrueHD', 'EAC3', 'Atmos']);
    expect(UNSUPPORTED_MODE_VALUES).toEqual(['exclude', 'deprioritize']);
    expect(SORT_VALUES).toEqual(['default', 'heaviest', 'lightest']);
    expect(DISPLAY_TEMPLATE_VALUES).toEqual(['direct', 'netflix', 'compact', 'detaille']);
  });
});

describe('configuration v2 : JSON schema et libellés FR', () => {
  type Node = { title?: string; description?: string; default?: unknown; properties?: Record<string, Node> };

  it('déclare les nouvelles clés, sans les rendre obligatoires', () => {
    const schema = configJsonSchema() as { properties: Record<string, Node>; required?: string[] };
    const keys = ['preset', 'filters', 'audio', 'sort', 'display', 'play'];
    for (const key of keys) {
      expect(schema.properties).toHaveProperty(key);
    }
    const required = schema.required ?? [];
    for (const key of keys) {
      expect(required).not.toContain(key);
    }
  });

  it('porte les titres et descriptions FR des sections', () => {
    const { properties } = configJsonSchema() as { properties: Record<string, Node> };
    expect(properties.preset).toMatchObject({ title: 'Préréglage' });
    expect(properties.filters).toMatchObject({ title: 'Filtres' });
    expect(properties.audio).toMatchObject({ title: 'Audio' });
    expect(properties.sort).toMatchObject({ title: 'Tri des flux', default: 'default' });
    expect(properties.display).toMatchObject({ title: 'Affichage' });
    expect(properties.play).toMatchObject({ title: 'Lecture' });
  });

  it('porte les titres FR des champs et leurs défauts', () => {
    const { properties } = configJsonSchema() as { properties: Record<string, Node> };
    const filters = properties.filters?.properties ?? {};
    expect(filters.ageLimit).toMatchObject({ title: "Limite d'âge", default: 'none' });
    expect(filters.hideUnreleased).toMatchObject({ title: 'Masquer les contenus non sortis', default: true });
    expect(filters.qualities).toMatchObject({ title: 'Qualités autorisées' });
    expect(filters.bitrate).toMatchObject({ title: 'Débit (Mbit/s)' });
    expect(filters.bitrate?.properties?.minMbps?.title).toBe('Débit minimum (Mbit/s)');
    expect(filters.bitrate?.properties?.maxMbps?.title).toBe('Débit maximum (Mbit/s)');
    expect(filters.maxPerResolution?.title).toBe('Maximum par résolution');
    expect(filters.allow3d).toMatchObject({ title: 'Autoriser la 3D', default: false });
    expect(filters.bannedWords?.title).toBe('Mots interdits');
    expect(filters.preferredWords?.title).toBe('Mots préférés');
    expect(filters.directVerifiedOnly?.title).toBe('Liens directs vérifiés uniquement');

    const audio = properties.audio?.properties ?? {};
    expect(audio.multichannel).toMatchObject({ title: 'Multicanal', default: 'none' });
    expect(audio.atmos).toMatchObject({ title: 'Dolby Atmos', default: 'none' });
    expect(audio.unsupportedFormats?.title).toBe('Formats audio non supportés');
    expect(audio.unsupportedMode).toMatchObject({ title: 'Traitement des formats non supportés', default: 'deprioritize' });
    expect(audio.verifiedLanguagesOnly).toMatchObject({ title: 'Seulement les langues vérifiées', default: false });
    expect(audio.probeTopN).toMatchObject({ title: 'Nombre de flux sondés', default: 5 });

    expect(properties.display?.properties?.template?.title).toBe("Modèle d'affichage");
    expect(properties.play?.properties?.budgetMs).toMatchObject({ title: 'Délai de résolution (ms)', default: 12000 });
  });
});
