import { describe, expect, it } from 'vitest';
import { audioLabel, formatDuration, hdrChips, toSourceView, toSourceViews, trackerHosts } from '../src/sources/info';
import { applyFilters, countByGroup, filtersActive, groupViews, NO_FILTERS, recommend, sortViews } from '../src/sources/rank';
import { getLaststream, type Stream } from '../src/data/stream';

const mk = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Stream => ({
  url: 'https://x/play/abc',
  description: 'AllDebrid',
  laststream: {
    resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 50,
    estBitrateKbps: 8000, sizeBytes: 8_000_000_000, ...over,
  },
  ...top,
});

describe('getLaststream : champs enrichis', () => {
  it('lit audio, canaux, copies, trackers et langues vérifiées sans casser les anciens flux', () => {
    const i = getLaststream(mk({ audio: ['TrueHD'], channels: '7.1', copies: 3, indexers: ['a', 'b'], releaseGroup: 'FGT', filename: 'f.mkv', languagesVerified: true, bitrateMbps: 12.5 }));
    expect(i).toMatchObject({ audio: ['TrueHD'], channels: '7.1', copies: 3, indexers: ['a', 'b'], releaseGroup: 'FGT', filename: 'f.mkv', verifiedLanguages: true, bitrateMbps: 12.5 });
    expect(getLaststream(mk())!.audio).toBeUndefined();
  });
});

describe('fiche de source', () => {
  it('détaille qualité, type, HDR, audio, langues vérifiées, débit et durée estimée', () => {
    const s = mk({ resolution: '2160p', source: 'REMUX', codec: 'HEVC', hdr: ['Dolby Vision', 'HDR10+'], audio: ['TrueHD'], channels: '7.1', frVariant: 'VFF', verifiedLanguages: ['fr'], sizeBytes: 60e9, estBitrateKbps: 60000, seeders: 120, peers: 30, releaseGroup: 'GRP', filename: 'Film.2160p.REMUX.mkv' });
    const v = toSourceView(s, 0);
    expect(v.quality).toBe('4K');
    expect(v.sourceType).toBe('REMUX');
    expect(v.hdr).toEqual(['DV', 'HDR10+']);
    expect(v.audio).toBe('TrueHD 7.1');
    expect(v.langs).toEqual([{ label: 'VFF', verified: true }]);
    expect(v.sizeLabel).toBe('60,0 Go');
    expect(v.bitrateLabel).toBe('60,0 Mb/s');
    expect(v.durationLabel).toBe('2 h 13');
    expect(v.seeders).toBe(120);
    expect(v.peers).toBe(30);
    expect(v.filename).toBe('Film.2160p.REMUX.mkv');
    expect(v.statusLabel).toBe('Cache AllDebrid ⚡ prêt');
  });

  it('statuts : non caché, P2P et lien direct', () => {
    expect(toSourceView(mk({ cached: false }), 0).statusLabel).toBe('Non caché (téléchargement)');
    const p2p = toSourceView({ infoHash: 'a'.repeat(40), laststream: (mk().laststream as object), sources: ['tracker:udp://tracker.example.org:80/announce'] }, 0);
    expect(p2p.status).toBe('p2p');
    expect(p2p.statusLabel).toBe('P2P');
    expect(p2p.isTorrent).toBe(true);
    expect(p2p.trackers).toEqual(['tracker.example.org']);
    expect(toSourceView({ url: 'https://cdn/x.mp4' }, 0).status).toBe('direct');
    expect(toSourceView({}, 0).playable).toBe(false);
  });

  it('audio déduit du nom de fichier quand l’addon ne le donne pas', () => {
    expect(audioLabel(undefined, undefined, 'Film.2160p.TrueHD.Atmos.7.1-GRP')).toBe('TrueHD Atmos 7.1');
    expect(audioLabel(undefined, undefined, 'Film.1080p.DDP5.1.x264')).toMatch(/^DDP/);
    expect(audioLabel(['EAC3'], '5.1')).toBe('DDP 5.1');
    expect(audioLabel(undefined, undefined, '')).toBe('');
  });

  it('puces HDR, trackers et durées', () => {
    expect(hdrChips(['HDR10', 'DV', 'HDR10+', 'HDR'])).toEqual(['DV', 'HDR10+', 'HDR10']);
    expect(trackerHosts(['tracker:udp://a.example:80', 'dht:abc', 'tracker:nope'])).toEqual(['a.example']);
    expect(formatDuration(47 * 60)).toBe('47 min');
    expect(formatDuration(null)).toBe('');
  });

  it('copies : nombre annoncé sinon calculé sur la liste', () => {
    const list = [mk(), mk(), mk({ resolution: '720p' })];
    expect(toSourceViews(list).map((v) => v.copies)).toEqual([2, 2, 1]);
    expect(toSourceView(mk({ copies: 5 }), 0, list).copies).toBe(5);
  });
});

describe('filtres, tri, regroupement', () => {
  const list = [
    mk({ resolution: '2160p', score: 90, hdr: ['HDR10'], languages: ['en'], cached: false, sizeBytes: 50e9, estBitrateKbps: 50000 }),
    mk({ resolution: '1080p', score: 80, languages: ['fr'], frVariant: 'VFF', sizeBytes: 9e9, estBitrateKbps: 9000 }),
    mk({ resolution: '1080p', score: 70, languages: ['multi'], sizeBytes: 12e9, estBitrateKbps: 12000 }),
    mk({ resolution: '720p', score: 60, languages: ['fr'], sizeBytes: 3e9, estBitrateKbps: 3000 }),
  ];
  const views = toSourceViews(list);

  it('filtre résolution, langue, cache et HDR', () => {
    expect(applyFilters(views, { ...NO_FILTERS, resolutions: new Set(['1080p']) }).map((v) => v.index)).toEqual([1, 2]);
    expect(applyFilters(views, { ...NO_FILTERS, langs: new Set(['multi']) }).map((v) => v.index)).toEqual([2]);
    expect(applyFilters(views, { ...NO_FILTERS, langs: new Set(['fr']) }).map((v) => v.index)).toEqual([1, 2, 3]);
    expect(applyFilters(views, { ...NO_FILTERS, langs: new Set(['vo']) }).map((v) => v.index)).toEqual([0]);
    expect(applyFilters(views, { ...NO_FILTERS, cachedOnly: true }).map((v) => v.index)).toEqual([1, 2, 3]);
    expect(applyFilters(views, { ...NO_FILTERS, hdrOnly: true }).map((v) => v.index)).toEqual([0]);
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, hdrOnly: true })).toBe(true);
  });

  it('trie par qualité, taille, débit et met le recommandé en tête', () => {
    expect(sortViews(views, 'quality').map((v) => v.index)).toEqual([0, 1, 2, 3]);
    expect(sortViews(views, 'size').map((v) => v.index)).toEqual([0, 2, 1, 3]);
    expect(sortViews(views, 'bitrate').map((v) => v.index)).toEqual([0, 2, 1, 3]);
    expect(sortViews(views, 'recommended', 2).map((v) => v.index)).toEqual([2, 0, 1, 3]);
  });

  it('groupe par résolution avec compteurs', () => {
    expect(groupViews(views).map((g) => [g.key, g.views.length])).toEqual([['2160p', 1], ['1080p', 2], ['720p', 1]]);
    expect(countByGroup(views)).toEqual({ '2160p': 1, '1080p': 2, '720p': 1 });
  });
});

describe('recommandation', () => {
  const views = toSourceViews([
    mk({ resolution: '2160p', score: 90, languages: ['en'], sizeBytes: 60e9, estBitrateKbps: 60000 }),
    mk({ resolution: '1080p', score: 70, languages: ['fr'], frVariant: 'VFF', estBitrateKbps: 20000 }),
    mk({ resolution: '720p', score: 50, languages: ['fr'], estBitrateKbps: 3000 }),
  ]);

  it('meilleure VF qui tient dans la connexion, avec la raison', () => {
    const r = recommend(views, 85_000, 'fr')!;
    expect(r.view.index).toBe(1);
    expect(r.languageFallback).toBe(false);
    expect(r.reason).toContain('Meilleure VF');
    expect(r.reason).toContain('85 Mb/s');
  });

  it('VF trop lourdes : repli VO signalé', () => {
    const r = recommend(toSourceViews([mk({ languages: ['en'], estBitrateKbps: 5000 }), mk({ languages: ['fr'], estBitrateKbps: 50000 })]), 10_000, 'fr')!;
    expect(r.view.index).toBe(0);
    expect(r.languageFallback).toBe(true);
    expect(r.reason).toContain('trop lourdes');
  });

  it('pas de VF du tout', () => {
    const r = recommend(toSourceViews([mk({ languages: ['en'] })]), null, 'fr')!;
    expect(r.languageFallback).toBe(true);
    expect(r.reason).toContain('Pas de VF disponible');
  });

  it('rien ne tient dans la connexion : la moins lourde est proposée', () => {
    const r = recommend(toSourceViews([mk({ estBitrateKbps: 40000 }), mk({ estBitrateKbps: 30000 })]), 5000, 'fr')!;
    expect(r.view.index).toBe(1);
    expect(r.reason).toContain('Aucune source ne tient');
  });

  it('ignore les sources illisibles et renvoie null sans source', () => {
    expect(recommend(toSourceViews([{}]), null)).toBeNull();
    expect(recommend([], null)).toBeNull();
  });
});
