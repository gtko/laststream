import { describe, expect, it } from 'vitest';
import { configJsonSchema, parseConfig } from '../src/config/schema.js';
import { effectiveSources } from '../src/sources/local-prowlarr.js';

describe('sources : champ enabled et ordre = priorité', () => {
  it('enabled vaut true par défaut pour chaque type de source', () => {
    const config = parseConfig({
      sources: [
        { type: 'upstream', name: 'U', url: 'https://u.example.com/' },
        { type: 'torznab', name: 'T', baseUrl: 'https://t.example.com', apiKey: 'torznab-key-123' },
        { type: 'prowlarr', name: 'P', baseUrl: 'http://localhost:9696', apiKey: 'prowlarr-key-123' },
        { type: 'jackett', name: 'J', baseUrl: 'https://j.example.com', apiKey: 'jackett-key-123' },
      ],
    });
    expect(config.sources.map((source) => source.enabled)).toEqual([true, true, true, true]);
  });

  it('enabled: false est accepté pour chaque type et conservé, l’ordre de la liste aussi', () => {
    const config = parseConfig({
      sources: [
        { type: 'upstream', name: 'U', url: 'https://u.example.com/', enabled: false },
        { type: 'torznab', name: 'T', baseUrl: 'https://t.example.com', apiKey: 'torznab-key-123', enabled: false },
        { type: 'prowlarr', name: 'P', baseUrl: 'http://localhost:9696', apiKey: 'prowlarr-key-123', enabled: true },
        { type: 'jackett', name: 'J', baseUrl: 'https://j.example.com', apiKey: 'jackett-key-123', enabled: false },
      ],
    });
    expect(config.sources.map((source) => [source.name, source.enabled])).toEqual([
      ['U', false],
      ['T', false],
      ['P', true],
      ['J', false],
    ]);
  });

  it('enabled non booléen : configuration refusée', () => {
    expect(() =>
      parseConfig({ sources: [{ type: 'upstream', name: 'U', url: 'https://u.example.com/', enabled: 'non' }] }),
    ).toThrow(/enabled/);
  });

  it('le JSON Schema expose enabled (titre « Activée ») et la description de l’ordre de priorité', () => {
    const schema = JSON.stringify(configJsonSchema());
    expect(schema).toContain('"Activée"');
    expect(schema).toContain("la première est prioritaire");
  });

  it('Prowlarr local inchangé : sans source explicite, la source détectée est activée', () => {
    const sources = effectiveSources(
      { sources: [], autoProwlarr: true },
      { baseUrl: 'http://localhost:9696', apiKey: 'local-key-123', indexerCount: 3 },
    );
    expect(sources).toEqual([
      { enabled: true, type: 'prowlarr', name: 'Prowlarr local', baseUrl: 'http://localhost:9696', apiKey: 'local-key-123' },
    ]);
  });
});
