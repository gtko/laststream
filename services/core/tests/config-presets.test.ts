import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { applyPreset, PRESETS, presetCatalog } from '../src/config/presets.js';
import { type Config, ConfigValidationError, PRESET_VALUES, parseConfig } from '../src/config/schema.js';
import { serveApp } from './serve.js';

const DEBRID = { service: 'alldebrid', apiKey: 'AD-KEY' } as const;

describe('préréglages : configurations valides', () => {
  it('chaque préréglage produit une configuration valide qui garde son identifiant', () => {
    for (const preset of PRESET_VALUES) {
      const config = parseConfig({ preset });
      expect(config.preset).toBe(preset);
    }
  });

  it('chaque préréglage reste valide avec un debrid configuré', () => {
    for (const preset of PRESET_VALUES) {
      expect(parseConfig({ preset, debrid: DEBRID }).debrid).toEqual(DEBRID);
    }
  });

  it('les valeurs de chaque préréglage sont valides seules', () => {
    for (const { values } of presetCatalog()) {
      expect(() => parseConfig(values)).not.toThrow();
    }
  });
});

describe('préréglages : valeurs attendues', () => {
  it('Essentiel : 1080p, 1440p et 2160p, fr + multi, 60 résultats, tri par défaut', () => {
    const config = parseConfig({ preset: 'essentiel' });
    expect(config.resolutions.allowed).toEqual(['2160p', '1440p', '1080p']);
    expect(config.resolutions.max).toBeUndefined();
    expect(config.languages).toEqual({ preferred: ['fr', 'multi'], acceptVostfr: true, fallbackToOthers: true });
    expect(config.maxResults).toBe(60);
    expect(config.sort).toBe('default');
  });

  it('Zen : 1080p maximum, VF/multi seulement, 5 résultats, affichage compact', () => {
    const config = parseConfig({ preset: 'zen' });
    expect(config.resolutions.max).toBe('1080p');
    expect(config.languages).toEqual({ preferred: ['fr', 'multi'], acceptVostfr: false, fallbackToOthers: false });
    expect(config.maxResults).toBe(5);
    expect(config.display.template).toBe('compact');
    expect(config.onlyCached).toBe(false);
  });

  it('Zen : onlyCached activé seulement quand un debrid est configuré', () => {
    expect(parseConfig({ preset: 'zen', debrid: DEBRID }).onlyCached).toBe(true);
    expect(parseConfig({ preset: 'zen' }).onlyCached).toBe(false);
  });

  it('Cinéphile : REMUX, BluRay, WEB-DL, 2160p autorisé, Atmos et 7.1 préférés, tri du plus lourd', () => {
    const config = parseConfig({ preset: 'cinephile' });
    expect(config.filters.qualities).toEqual(['REMUX', 'BluRay', 'WEB-DL']);
    expect(config.resolutions.allowed).toContain('2160p');
    expect(config.filters.preferredWords).toEqual(['Dolby Vision', 'DV', 'HDR']);
    expect(config.audio.atmos).toBe('prefer');
    expect(config.audio.multichannel).toBe('prefer7_1');
    expect(config.audio.unsupportedFormats).toEqual([]);
    expect(config.sort).toBe('heaviest');
    expect(config.display.template).toBe('detaille');
    expect(config.maxResults).toBe(20);
  });

  it('Nomade : débit, taille et formats audio limités, tri du plus léger, 10 résultats', () => {
    const config = parseConfig({ preset: 'nomade' });
    expect(config.filters.bitrate).toEqual({ maxMbps: 8 });
    expect(config.resolutions.max).toBe('1080p');
    expect(config.size.maxGb).toBe(4);
    expect(config.size.perResolution).toEqual({ '1080p': { maxGb: 3 }, '720p': { maxGb: 1.5 } });
    expect(config.audio.unsupportedFormats).toEqual(['DTS-HD', 'TrueHD', 'Atmos']);
    expect(config.audio.unsupportedMode).toBe('exclude');
    expect(config.sort).toBe('lightest');
    expect(config.display.template).toBe('compact');
    expect(config.maxResults).toBe(10);
  });
});

describe('préréglages : fusion avec les valeurs explicites', () => {
  it('une valeur explicite l’emporte sur le préréglage', () => {
    const config = parseConfig({ preset: 'zen', maxResults: 7 });
    expect(config.maxResults).toBe(7);
    expect(config.display.template).toBe('compact');
  });

  it('les objets sont fusionnés en profondeur : les autres valeurs du préréglage sont conservées', () => {
    const config = parseConfig({ preset: 'zen', languages: { preferred: ['en'] } });
    expect(config.languages).toEqual({ preferred: ['en'], acceptVostfr: false, fallbackToOthers: false });
  });

  it('un tableau explicite remplace celui du préréglage', () => {
    const config = parseConfig({ preset: 'cinephile', filters: { qualities: ['BluRay'] } });
    expect(config.filters.qualities).toEqual(['BluRay']);
    expect(config.filters.preferredWords).toEqual(['Dolby Vision', 'DV', 'HDR']);
  });

  it('un onlyCached explicite l’emporte sur celui du debrid du préréglage', () => {
    expect(parseConfig({ preset: 'zen', debrid: DEBRID, onlyCached: false }).onlyCached).toBe(false);
  });

  it('une taille par résolution explicite complète celle du préréglage', () => {
    const config = parseConfig({ preset: 'nomade', size: { perResolution: { '720p': { maxGb: 2 } } } });
    expect(config.size.maxGb).toBe(4);
    expect(config.size.perResolution).toEqual({ '1080p': { maxGb: 3 }, '720p': { maxGb: 2 } });
  });

  it('une valeur explicite invalide est toujours refusée', () => {
    expect(() => parseConfig({ preset: 'zen', maxResults: 0 })).toThrow(ConfigValidationError);
    expect(() => parseConfig({ preset: 'zen', languages: 'fr' })).toThrow(ConfigValidationError);
  });
});

describe('préréglages : absence ou identifiant inconnu', () => {
  it('sans préréglage, applyPreset renvoie l’entrée telle quelle', () => {
    const input = { maxResults: 12, filters: { allow3d: true } };
    expect(applyPreset(input)).toBe(input);
    expect(applyPreset(undefined)).toBeUndefined();
    expect(applyPreset(null)).toBeNull();
  });

  it('sans préréglage, les défauts et valeurs de l’entrée sont inchangés', () => {
    const defaults = parseConfig({});
    expect(defaults.maxResults).toBe(60);
    expect(defaults.resolutions.allowed).toEqual(['2160p', '1440p', '1080p', '720p', '480p', 'SD']);
    expect(defaults.languages).toEqual({ preferred: ['fr', 'multi'], acceptVostfr: true, fallbackToOthers: true });
    expect(defaults.onlyCached).toBe(false);
    expect(defaults.display.template).toBe('detaille');
    expect(parseConfig({ maxResults: 12 }).maxResults).toBe(12);
  });

  it('un préréglage inconnu reste une erreur de validation sur preset', () => {
    const input = { preset: 'inconnu', maxResults: 9 };
    expect(applyPreset(input)).toBe(input);
    try {
      parseConfig(input);
      expect.unreachable('parseConfig aurait dû échouer');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect((err as ConfigValidationError).issues.some((issue) => issue.startsWith('preset'))).toBe(true);
    }
  });

  it('ignore les noms hérités du prototype (constructor, toString) comme préréglages', () => {
    expect(applyPreset({ preset: 'constructor' })).toEqual({ preset: 'constructor' });
    expect(applyPreset({ preset: 'toString' })).toEqual({ preset: 'toString' });
  });
});

describe('préréglages : isolation', () => {
  it('ne modifie ni l’entrée ni les définitions des préréglages', () => {
    const input = { preset: 'zen' };
    const before = structuredClone(PRESETS.zen);
    applyPreset(input);
    expect(input).toEqual({ preset: 'zen' });
    parseConfig({ preset: 'zen', maxResults: 3, languages: { preferred: ['en'] } });
    expect(PRESETS.zen).toEqual(before);
  });

  it('un préréglage appliqué n’affecte pas les configurations suivantes', () => {
    parseConfig({ preset: 'zen', debrid: DEBRID });
    parseConfig({ preset: 'nomade' });
    const plain: Config = parseConfig({});
    expect(plain.maxResults).toBe(60);
    expect(plain.onlyCached).toBe(false);
    expect(plain.languages.fallbackToOthers).toBe(true);
    expect(plain.size.perResolution).toBeUndefined();
  });

  it('ignore les clés dangereuses de l’entrée sans polluer le prototype', () => {
    const input = JSON.parse('{"preset":"zen","__proto__":{"polluted":true}}') as Record<string, unknown>;
    const result = applyPreset(input) as Record<string, unknown>;
    expect(result.preset).toBe('zen');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});

describe('préréglages : catalogue et GET /config/schema', () => {
  it('le catalogue liste les 4 préréglages dans l’ordre, avec libellé et description', () => {
    const catalog = presetCatalog();
    expect(catalog.map((preset) => preset.id)).toEqual(['essentiel', 'zen', 'cinephile', 'nomade']);
    expect(catalog.map((preset) => preset.label)).toEqual(['Essentiel', 'Zen', 'Cinéphile', 'Nomade']);
    for (const preset of catalog) {
      expect(preset.description.length).toBeGreaterThan(0);
      expect(preset).toHaveProperty('values');
    }
  });

  describe('GET /config/schema', () => {
    const SECRET = 'presets-test-secret';
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
      const app = createApp({ secret: SECRET, allowPlain: false });
      server = serveApp(app);
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    });

    it('expose les 4 préréglages à côté du schéma existant', async () => {
      const res = await fetch(`${baseUrl}/config/schema`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        properties?: Record<string, unknown>;
        presets?: { id: string; label: string; description: string; values: Record<string, unknown> }[];
      };
      expect(body.properties).toHaveProperty('sources');
      expect(body.properties).toHaveProperty('preset');
      expect(body.presets?.map((preset) => preset.id)).toEqual(['essentiel', 'zen', 'cinephile', 'nomade']);
      for (const preset of body.presets ?? []) {
        expect(preset.label.length).toBeGreaterThan(0);
        expect(preset.description.length).toBeGreaterThan(0);
        expect(typeof preset.values).toBe('object');
      }
    });
  });
});
