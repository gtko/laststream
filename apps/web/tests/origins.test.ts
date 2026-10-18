import { describe, expect, it } from 'vitest';
import { getLaststream } from '../src/data/stream';
import { originSummary, originsOf, toSourceViews } from '../src/sources/info';
import { applyFilters, countOrigins, filtersActive, NO_FILTERS } from '../src/sources/rank';

const mk = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
  url: 'https://x/play/' + Math.random().toString(36).slice(2),
  laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 50, estBitrateKbps: 5000, ...over },
  ...top,
});

describe('origine des sources', () => {
  it('lit laststream.origins (addon, indexeur, Prowlarr local, logo http seulement)', () => {
    const i = getLaststream(mk({ origins: [
      { kind: 'addon', name: 'Lumio', logo: 'https://cdn/lumio.png' },
      { kind: 'indexer', name: 'C411', logo: 'javascript:alert(1)' },
      { kind: 'prowlarr-local', name: 'YggReborn' },
      { kind: 'inconnu', name: 'Autre' },
      { name: '' },
      'pas un objet',
    ] }))!;
    expect(i.origins).toEqual([
      { kind: 'addon', name: 'Lumio', logo: 'https://cdn/lumio.png' },
      { kind: 'indexer', name: 'C411' },
      { kind: 'prowlarr-local', name: 'YggReborn' },
      { kind: 'indexer', name: 'Autre' },
    ]);
  });

  it('repli : laststream.indexers, puis première ligne du nom du stream, sans doublon', () => {
    const idx = toSourceViews([mk({ indexers: ['C411', 'c411', 'YGG'] })] as never)[0];
    expect(idx.origins).toEqual([{ kind: 'indexer', name: 'C411' }, { kind: 'indexer', name: 'YGG' }]);
    const named = toSourceViews([mk({}, { name: 'Lumio\n1080p' })] as never)[0];
    expect(named.origins).toEqual([{ kind: 'addon', name: 'Lumio' }]);
    expect(toSourceViews([mk()] as never)[0].origins).toEqual([]);
    expect(originsOf(null, { name: 'Autre addon\n720p' })).toEqual([{ kind: 'addon', name: 'Autre addon' }]);
  });

  it('résumé : « C411, YGG +1 »', () => {
    const o = (n: string) => ({ kind: 'indexer' as const, name: n });
    expect(originSummary([])).toBe('');
    expect(originSummary([o('C411')])).toBe('C411');
    expect(originSummary([o('C411'), o('YGG')])).toBe('C411, YGG');
    expect(originSummary([o('C411'), o('YGG'), o('Lumio'), o('X')], 2)).toBe('C411, YGG +2');
    expect(originSummary([o('C411'), o('YGG')], 1)).toBe('C411 +1');
  });

  const views = toSourceViews([
    mk({ origins: [{ kind: 'addon', name: 'Lumio' }] }),
    mk({ origins: [{ kind: 'indexer', name: 'C411' }, { kind: 'addon', name: 'Lumio', logo: 'https://cdn/l.png' }] }),
    mk({ origins: [{ kind: 'indexer', name: 'C411' }] }),
    mk({}),
  ] as never);

  it('filtre « Origine » : une ou plusieurs origines, toute source qui en a une de choisie', () => {
    expect(filtersActive({ ...NO_FILTERS, origins: new Set(['C411']) })).toBe(true);
    expect(applyFilters(views, { ...NO_FILTERS, origins: new Set(['C411']) }).map((v) => v.index)).toEqual([1, 2]);
    expect(applyFilters(views, { ...NO_FILTERS, origins: new Set(['Lumio']) }).map((v) => v.index)).toEqual([0, 1]);
    expect(applyFilters(views, { ...NO_FILTERS, origins: new Set(['Lumio', 'C411']) }).map((v) => v.index)).toEqual([0, 1, 2]);
    expect(applyFilters(views, NO_FILTERS)).toHaveLength(4);
  });

  it('compteurs par origine, logo repris', () => {
    expect(countOrigins(views)).toEqual([
      { name: 'C411', count: 2, logo: undefined },
      { name: 'Lumio', count: 2, logo: 'https://cdn/l.png' },
    ]);
  });
});
