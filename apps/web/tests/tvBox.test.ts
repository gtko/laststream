// Ma box TV (Freebox) et playlists M3U de l'utilisateur : analyse, regroupement des qualités, fusion avec le catalogue,
// états web / hors du réseau local, masquage des adresses, synchronisation des définitions, guide XMLTV.
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeChannels, boxAccess, type MergeableChannel, boxOnlyChannels, BoxError, channelsFromText, fetchBoxChannels, maskUrl, mergeBox, mergeRemote, NOTE_AWAY, NOTE_WEB, NOTE_WEB_STREAM,
  parseM3u, parseTitle, pickQuality, refreshDue, toWire, type BoxList, type BoxTransport,
} from '../src/data/tvBox';
import { decodeXml, guideFromBytes, matchGuide, parseXmltv, parseXmltvTime as parseXmltime } from '../src/data/tvXmltv';
import { reconcileTvSources, setLists } from '../src/data/tvSources';

// Format réel de la Freebox, hôte et identifiants de service fictifs.
const FREEBOX = [
  '#EXTM3U',
  '#EXTINF:0,2 - France 2 (auto)', 'rtsp://box.test/fbxtv_pub/stream?namespace=1&service=2&flavour=ld',
  '#EXTINF:0,2 - France 2 (HD)', 'rtsp://box.test/fbxtv_pub/stream?namespace=1&service=2&flavour=hd',
  '#EXTINF:0,2 - France 2 (standard)', 'rtsp://box.test/fbxtv_pub/stream?namespace=1&service=2&flavour=sd',
  '#EXTINF:0,2 - France 2 (bas débit)', 'rtsp://box.test/fbxtv_pub/stream?namespace=1&service=2&flavour=ld',
  '#EXTINF:0,15 - BFM TV (auto)', 'rtsp://box.test/fbxtv_pub/stream?namespace=1&service=15&flavour=auto',
  '#EXTINF:0,15 - BFM TV (standard)', 'rtsp://box.test/fbxtv_pub/stream?namespace=1&service=15&flavour=sd',
  '#EXTINF:0,311 - Ma Chaîne Box (auto)', 'rtsp://box.test/fbxtv_pub/stream?namespace=1&service=311&flavour=auto',
].join('\n');

const IPTV = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="C1.fr" tvg-name="Canal Test" tvg-logo="https://img.test/c1.png" tvg-chno="7" group-title="Cinéma" catchup="default",Canal Test HD',
  'http://iptv.test:8080/live/user/pass/1.m3u8',
  '#EXTINF:-1 tvg-id="" group-title="Sport, Direct",Sport Un',
  'https://cdn.test/sport1/index.m3u8',
  '#EXTVLCOPT:http-user-agent=X',
  '#EXTINF:-1,Rien',
  'ftp://pas-un-flux/x',
].join('\n');

describe('parseM3u : Freebox', () => {
  it('regroupe les variantes d’une chaîne et garde le numéro de la box', () => {
    const list = parseM3u(FREEBOX, { list: 'box', freebox: true });
    expect(list.map((c) => [c.num, c.name])).toEqual([[2, 'France 2'], [15, 'BFM TV'], [311, 'Ma Chaîne Box']]);
    expect(list[0].qualities.map((q) => q.key).sort()).toEqual(['auto', 'hd', 'low', 'standard']);
    expect(list[0].local).toBe(true);
    expect(list[0].id).toBe('box:2-france2');
  });

  it('nettoie le titre : numéro, nom, qualité, suffixe HD', () => {
    expect(parseTitle('2 - France 2 (HD)')).toEqual({ num: 2, name: 'France 2', label: 'HD' });
    expect(parseTitle('12 - NRJ 12 HD (bas débit)')).toEqual({ num: 12, name: 'NRJ 12', label: 'bas débit' });
    expect(parseTitle('Arte')).toEqual({ num: 0, name: 'Arte', label: '' });
  });

  it('choisit HD par défaut, sinon auto, sinon ce qui existe', () => {
    const [fr2, bfm, own] = parseM3u(FREEBOX, { freebox: true });
    expect(pickQuality(fr2)?.key).toBe('hd');
    expect(pickQuality(bfm)?.key).toBe('auto');
    expect(pickQuality(own, 'standard')?.key).toBe('auto');
    expect(pickQuality(fr2, 'low')?.key).toBe('low');
    expect(pickQuality({ qualities: [] })).toBeNull();
  });
});

describe('parseM3u : playlist IPTV', () => {
  const list = parseM3u(IPTV, { list: 'pl1' });
  it('lit tvg-id, tvg-name, tvg-logo, tvg-chno et group-title (virgule entre guillemets comprise)', () => {
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ name: 'Canal Test', num: 7, group: 'Cinéma', tvgId: 'C1.fr', logo: 'https://img.test/c1.png', list: 'pl1' });
    expect(list[1]).toMatchObject({ name: 'Sport Un', num: 0, group: 'Sport, Direct' });
  });
  it('ignore les lignes #EXT… inconnues et les flux non pris en charge', () => {
    expect(list.map((c) => c.name)).not.toContain('Rien');
  });
  it('marque local un flux d’adresse privée seulement', () => {
    const l = parseM3u('#EXTM3U\n#EXTINF:-1,A\nhttp://192.168.1.5/a.ts\n#EXTINF:-1,B\nhttps://cdn.test/b.m3u8', {});
    expect(l.map((c) => c.local)).toEqual([true, false]);
  });
  it('refuse un contenu qui n’est pas M3U ou vide', () => {
    expect(() => channelsFromText('<html>x</html>')).toThrow(BoxError);
    expect(() => channelsFromText('#EXTM3U\n')).toThrow(/empty/);
  });
});

describe('fusion avec le catalogue', () => {
  const catalog = () => [
    { id: 'fr:France2.fr', name: 'France 2', epgId: 'France2.fr' },
    { id: 'fr:BFMTV.fr', name: 'BFMTV', epgId: 'BFMTV.fr' },
    { id: 'fr:Autre.fr', name: 'Autre chaîne' },
  ] as MergeableChannel[];

  it('rapproche par nom normalisé / numéro national : la version box devient source préférée', () => {
    const cat = catalog();
    const box = parseM3u(FREEBOX, { freebox: true });
    const matched = mergeBox(cat, box);
    expect(Array.from(matched).sort()).toEqual(['box:15-bfmtv', 'box:2-france2']);
    expect(cat[0].box).toMatchObject({ num: 2, quality: 'hd' });
    expect((cat[0].box as { url: string }).url).toContain('flavour=hd');
    expect(cat[2].box).toBeUndefined();
  });

  it('les chaînes inconnues du catalogue deviennent des chaînes « Box » avec leur numéro', () => {
    const box = parseM3u(FREEBOX, { freebox: true });
    const only = boxOnlyChannels(box, mergeBox(catalog(), box));
    expect(only).toHaveLength(1);
    expect(only[0]).toMatchObject({ name: 'Ma Chaîne Box', num: 311, source: 'box', boxOnly: true, sig: null, cat: 'Ma box' });
  });

  it('les catégories group-title sont préfixées pour ne pas se confondre avec celles du catalogue', () => {
    const only = boxOnlyChannels(parseM3u(IPTV, { list: 'pl1' }), new Set());
    expect(only.map((c) => c.cat)).toEqual(['Box · Cinéma', 'Box · Sport, Direct']);
  });
});

describe('états : navigateur et hors du réseau local', () => {
  const freebox = { url: 'rtsp://box.test/x', local: true };
  const publicHttps = { url: 'https://cdn.test/a.m3u8', local: false };
  const publicHttp = { url: 'http://iptv.test/a.ts', local: false };
  it('navigateur : flux box grisés avec explication, https public lisible', () => {
    expect(boxAccess(false, null, freebox)).toEqual({ ok: false, note: NOTE_WEB });
    expect(boxAccess(false, null, publicHttp)).toEqual({ ok: false, note: NOTE_WEB_STREAM });
    expect(boxAccess(false, null, publicHttps)).toEqual({ ok: true, note: '' });
  });
  it('app : la box injoignable grise les flux locaux seulement', () => {
    expect(boxAccess(true, false, freebox)).toEqual({ ok: false, note: NOTE_AWAY });
    expect(boxAccess(true, false, publicHttp).ok).toBe(true);
    expect(boxAccess(true, true, freebox).ok).toBe(true);
    expect(boxAccess(true, null, freebox).ok).toBe(true);
  });
});

describe('adresses et actualisation', () => {
  it('masque les identifiants d’une adresse de playlist', () => {
    expect(maskUrl('http://iptv.test:8080/get.php?username=bob&password=s3cret&type=m3u_plus')).toBe('http://iptv.test:8080/get.php?username=***&password=***&type=***');
    expect(maskUrl('http://iptv.test/live/bob/s3cret/12.m3u8')).toBe('http://iptv.test/…/12.m3u8');
    expect(maskUrl('http://iptv.test/live/bob/s3cret/12.m3u8')).not.toMatch(/bob|s3cret/);
    expect(maskUrl('pas une url')).toBe('…');
  });
  const base: BoxList = { id: 'a', name: 'A', kind: 'url', url: 'http://x.test/p.m3u', guideUrl: '', enabled: true, at: 0, channels: [] };
  it('actualise au plus une fois par jour, sauf désactivée ou fichier', () => {
    const now = 10 * 86_400_000;
    expect(refreshDue({ ...base, at: now - 3_600_000 }, now)).toBe(false);
    expect(refreshDue({ ...base, at: now - 86_400_000 }, now)).toBe(true);
    expect(refreshDue({ ...base, enabled: false }, now)).toBe(false);
    expect(refreshDue({ ...base, kind: 'file', url: '' }, now)).toBe(false);
  });
  it('plusieurs playlists : seules les actives comptent', () => {
    const a = parseM3u(IPTV, { list: 'a' });
    const b = parseM3u(FREEBOX, { list: 'b' });
    const ids = activeChannels([{ ...base, id: 'a', channels: a }, { ...base, id: 'b', enabled: false, channels: b }]).map((c) => c.list);
    expect(new Set(ids)).toEqual(new Set(['a']));
  });
});

describe('transport de l’appareil', () => {
  const ok = (text: string): BoxTransport => ({
    native: async () => ({ status: 200, headers: {}, body: new TextEncoder().encode(text) }),
    fetchHttp: async () => { throw new Error('réseau'); },
  });
  it('lit la playlist par le pont natif', async () => {
    expect(await fetchBoxChannels('http://mafreebox.freebox.fr/freeboxtv/playlist.m3u', { freebox: true }, ok(FREEBOX))).toHaveLength(3);
  });
  it('sans pont (web) : message « disponible dans les apps »', async () => {
    const web: BoxTransport = { native: null, fetchHttp: async () => { throw new Error('mixed content'); } };
    await expect(fetchBoxChannels('http://mafreebox.freebox.fr/freeboxtv/playlist.m3u', {}, web)).rejects.toMatchObject({ code: 'web_unavailable' });
  });
  it('refuse une adresse non http(s) ou avec identifiants, et un contenu non M3U', async () => {
    await expect(fetchBoxChannels('rtsp://box/x', {}, ok(FREEBOX))).rejects.toMatchObject({ code: 'invalid_url' });
    await expect(fetchBoxChannels('http://u:p@h.test/p.m3u', {}, ok(FREEBOX))).rejects.toMatchObject({ code: 'invalid_url' });
    await expect(fetchBoxChannels('http://h.test/p.m3u', {}, ok('<html></html>'))).rejects.toMatchObject({ code: 'not_m3u' });
  });
  it('erreur du pont (garde d’URL, taille) traduite', async () => {
    const tr: BoxTransport = { native: async () => { throw Object.assign(new Error('x'), { code: 'too_large' }); }, fetchHttp: async () => { throw new Error('x'); } };
    await expect(fetchBoxChannels('http://h.test/p.m3u', {}, tr)).rejects.toMatchObject({ code: 'too_large' });
  });
});

describe('synchronisation avec le compte', () => {
  beforeEach(() => { localStorage.clear(); setLists([], false); });
  const wire = { id: 'r1', name: 'Mon IPTV', kind: 'url' as const, url: 'http://iptv.test/get.php?username=u&password=p', guideUrl: 'http://iptv.test/epg.xml.gz', enabled: true };
  it('le compte fait foi pour les listes synchronisées, les listes de l’appareil restent', () => {
    const local: BoxList[] = [
      { id: 'file1', name: 'Fichier', kind: 'file', url: '', guideUrl: '', enabled: true, at: 1, channels: parseM3u(IPTV, { list: 'file1' }) },
      { id: 'old', name: 'Ancienne', kind: 'url', url: 'http://old.test/p.m3u', guideUrl: '', enabled: true, at: 1, channels: [], synced: true },
    ];
    const merged = mergeRemote(local, [wire]);
    expect(merged.map((l) => l.id)).toEqual(['r1', 'file1']);
    expect(merged[0]).toMatchObject({ synced: true, at: 0, channels: [] });
  });
  it('reprend les chaînes déjà lues quand l’adresse n’a pas changé', () => {
    const chans = parseM3u(IPTV, { list: 'r1' });
    const merged = mergeRemote([{ ...wire, at: 5, channels: chans, synced: true }], [wire]);
    expect(merged[0].channels).toBe(chans);
    expect(merged[0].at).toBe(5);
  });
  it('n’envoie que les listes synchronisées avec adresse (jamais fichier ni Freebox propre à l’appareil)', () => {
    const lists: BoxList[] = [
      { ...wire, at: 1, channels: [], synced: true },
      { id: 'box', name: 'Freebox', kind: 'freebox', url: 'http://mafreebox.freebox.fr/freeboxtv/playlist.m3u', guideUrl: '', enabled: true, at: 1, channels: [] },
      { id: 'f', name: 'F', kind: 'file', url: '', guideUrl: '', enabled: true, at: 1, channels: [], synced: true },
    ];
    expect(toWire(lists).map((w) => w.id)).toEqual(['r1']);
    expect(Object.keys(toWire(lists)[0]).sort()).toEqual(['enabled', 'guideUrl', 'id', 'kind', 'name', 'url']);
  });
  it('réconciliation : rien côté compte → envoi si l’appareil en a ; sinon le compte remplace', () => {
    expect(reconcileTvSources(null)).toBe('none');
    setLists(mergeRemote([], [wire]), false);
    expect(reconcileTvSources([])).toBe('push');
    expect(reconcileTvSources([wire])).toBe('none');
    expect(reconcileTvSources([{ ...wire, name: 'Renommée' }])).toBe('pulled');
  });
});

describe('guide XMLTV', () => {
  const NOW = Date.UTC(2026, 0, 15, 20, 0, 0) / 1000;
  const XML = [
    '<?xml version="1.0" encoding="UTF-8"?><tv>',
    '<channel id="C1.fr"><display-name>Canal Test</display-name></channel>',
    '<channel id="x2"><display-name>Sport Un</display-name></channel>',
    `<programme start="20260115210000 +0100" stop="20260115220000 +0100" channel="C1.fr"><title lang="fr">Film &amp; Co</title><desc>Un film.</desc></programme>`,
    `<programme start="20260115220000 +0100" stop="20260115233000 +0100" channel="C1.fr"><title>Suite</title></programme>`,
    `<programme start="20260115200000 +0000" stop="20260115210000 +0000" channel="x2"><title><![CDATA[Match]]></title></programme>`,
    `<programme start="20260110200000 +0000" stop="20260110210000 +0000" channel="x2"><title>Trop ancien</title></programme>`,
    `<programme start="20260120200000 +0000" stop="20260120210000 +0000" channel="x2"><title>Trop loin</title></programme>`,
    '</tv>',
  ].join('\n');
  const targets = [{ id: 'pl1:7-canaltest', name: 'Canal Test', tvgId: 'C1.fr' }, { id: 'pl1:x-sportun', name: 'Sport Un' }, { id: 'pl1:x-aucun', name: 'Aucun' }];

  it('lit les heures avec fuseau', () => {
    expect(parseXmltime('20260115210000 +0100')).toBe(Date.UTC(2026, 0, 15, 20, 0, 0) / 1000);
    expect(parseXmltime('20260115200000')).toBe(NOW);
    expect(parseXmltime('n’importe quoi')).toBeNull();
    expect(decodeXml('A &amp; B &#233; &lt;')).toBe('A & B é <');
  });

  it('lit en flux (découpé n’importe où) et ne garde que maintenant → +24 h', async () => {
    const chunks = XML.match(/[\s\S]{1,37}/g) as string[];
    const g = await parseXmltv(chunks, NOW, NOW + 86400);
    expect([...g.progs.keys()].sort()).toEqual(['C1.fr', 'x2']);
    expect(g.progs.get('x2')?.map((p) => p.title)).toEqual(['Match']);
    expect(g.progs.get('C1.fr')?.[0]).toMatchObject({ title: 'Film & Co', desc: 'Un film.' });
  });

  it('correspondance par tvg-id puis par nom', async () => {
    const g = await parseXmltv([XML], NOW, NOW + 86400);
    const m = matchGuide(targets, g);
    expect(Object.keys(m).sort()).toEqual(['pl1:7-canaltest', 'pl1:x-sportun']);
    expect(m['pl1:7-canaltest'].map((t) => t[2])).toEqual(['Film & Co', 'Suite']);
    expect(m['pl1:x-sportun'][0][2]).toBe('Match');
  });

  it('décompresse un .xml.gz', async () => {
    if (typeof DecompressionStream === 'undefined' || typeof Blob.prototype.stream !== 'function') return;
    const g = await guideFromBytes(new Uint8Array(gzipSync(Buffer.from(XML))), targets, NOW);
    expect(Object.keys(g.progs)).toHaveLength(2);
  });
});

vi.stubGlobal('Capacitor', undefined);
