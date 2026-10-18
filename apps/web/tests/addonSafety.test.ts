// Sécurité des addons : détection de clé de débrideur dans l’adresse, réécriture, classification des flux, masquage.
import { describe, expect, it } from 'vitest';
import { analyzeAddonUrl, classifyStreams, isDebridUrl, maskKey } from '../src/data/addonSafety';

const b64u = (o: unknown): string => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_');
const decodeSeg = (seg: string): Record<string, unknown> => {
  const std = seg.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(std + '='.repeat((4 - (std.length % 4)) % 4)));
};
const segmentOf = (url: string): string => new URL(url).pathname.split('/')[1];

describe('détection et réécriture Torrentio', () => {
  it('repère une option débrideur, masque la clé et retire l’option', () => {
    const a = analyzeAddonUrl('https://torrentio.strem.fun/realdebrid=RDKEY1234567890/manifest.json');
    expect(a.format).toBe('torrentio');
    expect(a.usesDebrid).toBe(true);
    expect(a.service).toBe('realdebrid');
    expect(a.masked).toEqual(['RDKE…7890']);
    expect(a.fix?.url).toBe('https://torrentio.strem.fun/manifest.json');
  });

  it('repère plusieurs options débrideur séparées par | et garde les autres options', () => {
    const a = analyzeAddonUrl('https://torrentio.strem.fun/sort=qualitysize|alldebrid=ADKEY1234567890|qualityfilter=480p|premiumize=PMKEY0987654321/manifest.json');
    expect(a.masked).toEqual(['ADKE…7890', 'PMKE…4321']);
    expect(a.fix?.url).toBe('https://torrentio.strem.fun/sort=qualitysize|qualityfilter=480p/manifest.json');
  });

  it('sans option débrideur ou sans clé : rien à corriger', () => {
    expect(analyzeAddonUrl('https://torrentio.strem.fun/sort=qualitysize/manifest.json')).toMatchObject({ usesDebrid: false, fix: null });
    expect(analyzeAddonUrl('https://torrentio.strem.fun/alldebrid=/manifest.json')).toMatchObject({ usesDebrid: false, fix: null });
  });

  it('les aperçus avant / après ne contiennent jamais la clé en clair', () => {
    const a = analyzeAddonUrl('https://torrentio.strem.fun/alldebrid=ADKEY1234567890|sort=qualitysize/manifest.json');
    expect(a.fix?.before).toContain('ADKE…7890');
    expect(a.fix?.before).not.toContain('ADKEY1234567890');
    expect(a.fix?.after).not.toContain('ADKEY1234567890');
  });
});

describe('détection et réécriture de configuration base64 JSON', () => {
  it('service et clé présents : clé retirée, service mis à « torrent », segment réencodé en base64url', () => {
    const url = `https://comet.example/${b64u({ debridService: 'alldebrid', debridApiKey: 'ABCDEFGH12345678', sort: 'quality' })}/manifest.json`;
    const a = analyzeAddonUrl(url);
    expect(a.format).toBe('json');
    expect(a.usesDebrid).toBe(true);
    expect(a.service).toBe('alldebrid');
    expect(a.masked).toEqual(['ABCD…5678']);
    expect(a.fix).not.toBeNull();
    const fixed = a.fix!.url;
    expect(fixed).not.toContain('ABCDEFGH12345678');
    expect(segmentOf(fixed)).not.toMatch(/[+/]/); // reste en base64url
    expect(decodeSeg(segmentOf(fixed))).toEqual({ debridService: 'torrent', sort: 'quality' });
    expect(a.fix!.before).toContain('ABCD…5678');
    expect(a.fix!.before).not.toContain('ABCDEFGH12345678');
    expect(a.fix!.after).not.toContain('ABCDEFGH12345678');
  });

  it('configuration sans clé : pas un usage de débrideur, rien à corriger', () => {
    expect(analyzeAddonUrl(`https://comet.example/${b64u({ debridService: 'torrent', sort: 'quality' })}/manifest.json`))
      .toMatchObject({ usesDebrid: false, fix: null });
  });

  it('une clé d’API générique sans debridService (TMDB, par ex.) n’est pas une clé de débrideur', () => {
    expect(analyzeAddonUrl(`https://addon.example/${b64u({ apiKey: 'ABCDEFGH12345678' })}/manifest.json`))
      .toMatchObject({ usesDebrid: false, fix: null });
  });

  it('clé de débrideur sans schéma évident : détectée, mais pas réécrite automatiquement', () => {
    const a = analyzeAddonUrl(`https://addon.example/${b64u({ alldebrid: 'ABCDEFGH12345678' })}/manifest.json`);
    expect(a.usesDebrid).toBe(true);
    expect(a.masked).toEqual(['ABCD…5678']);
    expect(a.fix).toBeNull();
  });

  it('configuration opaque chez l’addon (identifiant) : rien à lire, rien à réécrire', () => {
    expect(analyzeAddonUrl('https://streamfusion.example/3f2b8c1e-aaaa-4bbb-8ccc-1234567890ab/manifest.json'))
      .toEqual({ format: 'none', usesDebrid: false, masked: [], service: '', fix: null });
  });
});

describe('classification du comportement', () => {
  it('maskKey : quatre premiers et quatre derniers caractères, rien pour une valeur courte', () => {
    expect(maskKey('ABCDEFGH12345678')).toBe('ABCD…5678');
    expect(maskKey('short')).toBe('…');
  });

  it('reconnaît les hébergeurs débrideurs et les liens de résolution de l’addon', () => {
    const origin = 'https://addon.example';
    expect(isDebridUrl('https://x.debrid.it/abc', origin)).toBe(true);
    expect(isDebridUrl('https://foo.real-debrid.com/d/x', origin)).toBe(true);
    expect(isDebridUrl('https://api.torbox.app/x', origin)).toBe(true);
    expect(isDebridUrl('https://addon.example/resolve/alldebrid/abc', origin)).toBe(true);
    expect(isDebridUrl('https://addon.example/playback/xyz', origin)).toBe(true);
    expect(isDebridUrl('https://addon.example/r/xyz', origin)).toBe(true);
    expect(isDebridUrl('https://cdn.example/video.mp4', origin)).toBe(false);
    expect(isDebridUrl('https://other.example/resolve/x', origin)).toBe(false); // autre origine : pas l’addon
  });

  it('infoHash = sûr ; lien débrideur = débrideur (il l’emporte) ; rien de lisible = inconnu', () => {
    const origin = 'https://addon.example';
    expect(classifyStreams([{ infoHash: 'a'.repeat(40) }], origin)).toBe('safe');
    expect(classifyStreams([{ infoHash: 'a'.repeat(40) }, { url: 'https://foo.real-debrid.com/d/x' }], origin)).toBe('debrid');
    expect(classifyStreams([{ url: 'https://addon.example/resolve/x' }], origin)).toBe('debrid');
    expect(classifyStreams([{ url: 'https://cdn.example/a.mp4' }], origin)).toBe('unknown');
    expect(classifyStreams([], origin)).toBe('unknown');
    expect(classifyStreams(null, origin)).toBe('unknown');
  });
});
