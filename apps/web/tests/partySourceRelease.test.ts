// LAST-1620 : sources lisibles (fournisseur, release, infos techniques), doublons regroupés, repli vers la même release chez un
// autre fournisseur d'abord, message de repli.
import { describe, expect, it } from 'vitest';
import { sourceKeyOf, toSourceViews, type SourceView } from '../src/sources/info';
import { groupReleases, normalizedFilename, providerOf, sameRelease, sourceDetail } from '../src/sources/release';
import { buildSourceRows } from '../src/party/lobbyModel';
import { failoverOrder, failoverStatusText, fileLevelFailure, pickRaceCandidate } from '../src/player/failover';

/** Source directe d'un addon : `addon` (origine), fichier, taille, et options du flux. */
function direct(n: number, addon: string, file: string, size: number, extra: Record<string, unknown> = {}, stream: Record<string, unknown> = {}) {
  return {
    url: 'https://' + addon.toLowerCase() + '.example/f/' + n,
    behaviorHints: { filename: file, videoSize: size },
    laststream: { resolution: '2160p', height: 2160, source: 'WEB-DL', codec: 'HEVC', hdr: ['DV'], audio: 'EAC3 5.1', languages: ['fr'], cached: false, score: 90 - n, estBitrateKbps: 15000, origins: [{ kind: 'addon', name: addon }], ...extra },
    ...stream,
  };
}
const views = (...s: unknown[]): SourceView[] => toSourceViews(s as never);

const FILE = 'The.Mandalorian.S03E08.MULTi.2160p.WEB-DL.DV.HEVC-GRP.mkv';

describe('identité de release', () => {
  it('nom de fichier normalisé : casse, séparateurs et extension ignorés', () => {
    expect(normalizedFilename('The Mandalorian_S03E08.MULTi.2160p.mkv')).toBe(normalizedFilename('the.mandalorian.s03e08.multi.2160p.mp4'));
    expect(normalizedFilename('')).toBe('');
  });
  it('même fichier chez deux addons : même release, taille arrondie tolérée', () => {
    const [a, b] = views(direct(1, 'Lumpi', FILE, 18.3e9), direct(2, 'StreamFusion', FILE.replace(/\./g, ' '), 18.31e9));
    expect(sameRelease(a, b)).toBe(true);
  });
  it('même nom mais taille très différente : pas la même release', () => {
    const [a, b] = views(direct(1, 'Lumpi', FILE, 18.3e9), direct(2, 'StreamFusion', FILE, 3.9e9));
    expect(sameRelease(a, b)).toBe(false);
  });
  it('même hash d’info : même release ; fichiers différents du même torrent : non', () => {
    const [a, b, c] = views(
      direct(1, 'A', 'x.mkv', 0, {}, { infoHash: 'ABC', fileIdx: 1 }),
      direct(2, 'B', 'y.mkv', 0, {}, { infoHash: 'abc', fileIdx: 1 }),
      direct(3, 'C', 'z.mkv', 0, {}, { infoHash: 'abc', fileIdx: 2 }),
    );
    expect(sameRelease(a, b)).toBe(true);
    expect(sameRelease(a, c)).toBe(false);
  });
  it('sans nom : même taille exacte d’un gros fichier dans la même qualité', () => {
    const [a, b, c] = views(direct(1, 'A', '', 4.9e9), direct(2, 'B', '', 4.9e9), direct(3, 'C', '', 4.9e9, { resolution: '1080p', height: 1080 }));
    expect(sameRelease(a, b)).toBe(true);
    expect(sameRelease(a, c)).toBe(false);
    // Nom connu d'un seul côté, ou autre version (codec) : la taille seule ne prouve rien.
    const [named, hevc, avc] = views(direct(4, 'D', FILE, 4.9e9), direct(5, 'E', '', 4.9e9), direct(6, 'F', '', 4.9e9, { codec: 'AVC' }));
    expect(sameRelease(named, b)).toBe(false);
    expect(sameRelease(hevc, avc)).toBe(false);
  });
  it('fournisseur : addon d’origine, et rien d’inventé quand il est inconnu', () => {
    const [a] = views(direct(1, 'Lumpi', FILE, 1e9));
    expect(providerOf(a)).toBe('Lumpi');
    const [b] = views({ url: 'https://x/y.mkv', behaviorHints: { filename: 'y.mkv' } });
    expect(providerOf(b)).toBe('');
  });
  it('infos techniques : source, codec, HDR, audio, débit, seeders', () => {
    const [a] = views(direct(1, 'Lumpi', FILE, 1e9, { seeders: 85 }));
    const d = sourceDetail(a);
    for (const part of ['WEB-DL', 'HEVC', 'DV', 'DDP 5.1', '15,0 Mb/s', '85 seeders']) expect(d).toContain(part);
  });
  it('regroupement : une entrée par release, nombre d’autres fournisseurs', () => {
    const v = views(direct(1, 'Lumpi', FILE, 18.3e9), direct(2, 'StreamFusion', FILE, 18.3e9), direct(3, 'Lumpi', 'Other.2160p.mkv', 3.9e9), direct(4, 'Torrentio', FILE, 18.3e9));
    const g = groupReleases(v);
    expect(g).toHaveLength(2);
    expect(g[0].members).toHaveLength(3);
    expect(g[0].others).toBe(2);
    expect(g[1].others).toBe(0);
  });
});

describe('« Ma source » : lignes distinctes', () => {
  const base = { selectedKey: '', hostLabel: null, roomLanguage: 'fr' as const };
  it('chaque ligne porte fournisseur, release et infos ; les doublons sont regroupés', () => {
    const v = views(direct(1, 'Lumpi', FILE, 18.3e9), direct(2, 'StreamFusion', FILE, 18.3e9), direct(3, 'Lumpi', 'Other.Release.2160p.mkv', 3.9e9));
    const rows = buildSourceRows(v, { ...base, order: [] });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ provider: 'Lumpi', others: 1, release: FILE });
    expect(rows[0].detail).toContain('HEVC');
    expect(rows[1]).toMatchObject({ provider: 'Lumpi', others: 0 });
  });
  it('la source choisie reste la ligne affichée de sa release, même si un doublon est mieux classé', () => {
    const v = views(direct(1, 'Lumpi', FILE, 18.3e9), direct(2, 'StreamFusion', FILE, 18.3e9));
    const chosen = buildSourceRows(v, { ...base, order: [] })[0];
    const other = views(direct(2, 'StreamFusion', FILE, 18.3e9))[0];
    const rows = buildSourceRows(v, { ...base, selectedKey: sourceKeyOf(other), order: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'StreamFusion', selected: true, others: 1 });
    expect(chosen.provider).toBe('Lumpi');
  });
  it('une ligne déjà affichée garde sa clé quand un doublon mieux classé arrive au sondage suivant', () => {
    const order: string[] = [];
    const first = buildSourceRows(views(direct(5, 'StreamFusion', FILE, 18.3e9)), { ...base, order });
    const second = buildSourceRows(views(direct(5, 'StreamFusion', FILE, 18.3e9), direct(1, 'Lumpi', FILE, 18.3e9)), { ...base, order });
    expect(second).toHaveLength(1);
    expect(second[0].key).toBe(first[0].key);
    expect(second[0].others).toBe(1);
  });
});

describe('repli : même release chez un autre fournisseur d’abord', () => {
  // 0 : Lumpi (en échec) ; 1 : autre release mieux classée ; 2 : même fichier chez StreamFusion ; 3 : autre langue
  const ranked = views(
    direct(0, 'Lumpi', FILE, 18.3e9),
    direct(1, 'Lumpi', 'Better.Copy.2160p.WEB-DL.mkv', 9e9),
    direct(2, 'StreamFusion', FILE, 18.3e9),
    direct(3, 'Torrentio', 'English.2160p.mkv', 8e9, { languages: ['en'] }),
  );
  it('ordre : doublon, copie équivalente, puis le reste', () => {
    const order = failoverOrder(ranked, ranked[0], new Set([0]), 'La lecture est bloquée');
    expect(order.map((v) => v.index)).toEqual([2, 1, 3]);
  });
  it('échec du fichier lui-même (décodage) : le doublon passe en dernier', () => {
    expect(fileLevelFailure('Erreur de lecture (media-error:4)')).toBe(true);
    expect(fileLevelFailure('La source met trop de temps à démarrer')).toBe(false);
    expect(fileLevelFailure('Lien expiré (plus d’informations côté débrideur)')).toBe(false);
    const order = failoverOrder(ranked, ranked[0], new Set([0]), 'Erreur de lecture (media-error:4)');
    expect(order.map((v) => v.index)).toEqual([1, 3, 2]);
  });
  it('doublon déjà essayé : la meilleure source restante', () => {
    expect(failoverOrder(ranked, ranked[0], new Set([0, 2])).map((v) => v.index)).toEqual([1, 3]);
  });
  it('course de démarrage : le doublon est choisi avant une copie plus facile à lire', () => {
    const r = ranked.map((v) => ({ ...v, web: v.index === 1 ? 'direct' : 'unknown' })) as SourceView[];
    const pick = pickRaceCandidate(r, r[0], new Set([0]), new Set(), (v) => String(v.index));
    expect(pick!.index).toBe(2);
  });
  it('doublon mémorisé en échec : écarté de la course', () => {
    const pick = pickRaceCandidate(ranked, ranked[0], new Set([0]), new Set(['2']), (v) => String(v.index));
    expect(pick!.index).toBe(1);
  });
  it('message : ce qui a échoué, ce qui est essayé, « même fichier »', () => {
    const t = failoverStatusText(ranked[0], 'La lecture est bloquée', ranked[2], 2, 6);
    expect(t).toBe('Échec de Lumpi (VF · 4K) : La lecture est bloquée. Essai de StreamFusion (VF · 4K) · même fichier (2/6)');
    const t2 = failoverStatusText(ranked[0], 'Erreur.', ranked[3], 3, 6, 'hors langue du salon');
    expect(t2).toContain('Essai de Torrentio');
    expect(t2).toContain('hors langue du salon (3/6)');
    expect(t2).not.toContain('même fichier');
  });
});
