// Source du salon (LAST-1615, lot L6) : lignes de la liste, code de langue envoyé au serveur (jamais « multi »), départ avec le choix.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSourceRows, hostSourceLine, noSourceInRoomLanguage, sourceLanguageWarning, sourceSearchText } from '../src/party/lobbyModel';
import { choiceReason, sourceLangCode } from '../src/party/sourceChoice';
import { sourceKeyOf, toSourceViews } from '../src/sources/info';
import { partyBridge } from '../src/party/bridge';

const stream = (n: number, extra: Record<string, unknown> = {}) => ({
  url: 'https://x/play/c/' + n,
  behaviorHints: { filename: 'Dune.' + n + '.mkv', videoSize: 3e9 + n },
  laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 50 + n, estBitrateKbps: 5000, ...extra },
});
const views = (...s: unknown[]) => toSourceViews(s as never);

describe('sourceLangCode : jamais de multi ni de langue inconnue', () => {
  it('fr, en, vo : codes de 2 à 3 lettres', () => {
    expect(sourceLangCode(views(stream(1))[0])).toBe('fr');
    expect(sourceLangCode(views(stream(2, { languages: ['en'] }))[0])).toBe('en');
    expect(sourceLangCode(views(stream(3, { languages: ['original'] }))[0])).toBe('vo');
  });
  it('multi ou langue inconnue : null (la langue du salon ne change pas)', () => {
    expect(sourceLangCode(views(stream(4, { languages: ['multi'] }))[0])).toBeNull();
    expect(sourceLangCode(views(stream(5, { languages: [] }))[0])).toBeNull();
    expect(sourceLangCode(views(stream(6, { languages: ['klingon'] }))[0])).toBeNull();
  });
});

describe('hôte : annonce de sa source', () => {
  afterEach(() => { partyBridge.client = null; });
  const hostClient = () => ({ isHost: true, room: { fingerprint: null }, sendSource: vi.fn(() => true) }) as any;

  it('source multi : aucune langue n’est envoyée', () => {
    const c = hostClient();
    partyBridge.client = c;
    partyBridge.announceSource(views(stream(7, { languages: ['multi'] }))[0]);
    expect(c.sendSource).toHaveBeenCalledTimes(1);
    expect(c.sendSource.mock.calls[0][1]).toBeUndefined();
  });
  it('source en anglais : la langue est envoyée ; un invité n’envoie rien', () => {
    const c = hostClient();
    partyBridge.client = c;
    partyBridge.announceSource(views(stream(8, { languages: ['en'] }))[0]);
    expect(c.sendSource.mock.calls[0][1]).toBe('en');
    const guest = { ...hostClient(), isHost: false };
    partyBridge.client = guest;
    partyBridge.announceSource(views(stream(9, { languages: ['en'] }))[0]);
    expect(guest.sendSource).not.toHaveBeenCalled();
  });
});

describe('départ du salon d’attente', () => {
  afterEach(() => { partyBridge.client = null; partyBridge.launcher = null; });
  it('la source choisie est transmise au lanceur avec les options de salon intactes', async () => {
    const [fr, en] = views(stream(1), stream(2, { languages: ['en'] }));
    const loaded = { imdb: 'tt1', views: [fr, en], pending: [] };
    const launcher = vi.fn(async () => undefined);
    partyBridge.launcher = launcher as never;
    partyBridge.client = { room: { id: 'r', title: 'Dune', language: 'fr', fingerprint: null, media: { type: 'movie', tmdbId: 5 } }, participants: [{ host: true, quality: 'VF · 1080p' }], v3: false } as any;
    await partyBridge.launchRoom({ view: en, loaded });
    expect(launcher).toHaveBeenCalledTimes(1);
    const opts = (launcher.mock.calls[0] as unknown[])[1] as any;
    expect(opts.chosen).toBe(en);
    expect(opts.chosenLoaded).toBe(loaded);
    expect(opts.partyLang).toBe('fr');
    expect(opts.hostLabel).toBe('VF · 1080p');
    expect(opts.resume).toBe('none');
    expect(typeof opts.prefer).toBe('function');
  });
  it('sans choix : lancement habituel, aucune source imposée', async () => {
    const launcher = vi.fn(async () => undefined);
    partyBridge.launcher = launcher as never;
    partyBridge.client = { room: { id: 'r', title: 'Dune', language: 'fr', fingerprint: null, media: { type: 'movie', tmdbId: 5 } }, participants: [], v3: false } as any;
    await partyBridge.launchRoom();
    const opts = (launcher.mock.calls[0] as unknown[])[1] as any;
    expect(opts.chosen).toBeUndefined();
  });
});

describe('modèle de la liste', () => {
  const [fr1080, fr720, en720] = views(stream(1), stream(2, { resolution: '720p', height: 720, score: 40 }), stream(3, { resolution: '720p', height: 720, languages: ['en'], score: 30 }));
  it('lignes triées, sélection, pastilles hôte et autre langue', () => {
    const rows = buildSourceRows([en720, fr720, fr1080], { selectedKey: sourceKeyOf(fr720), hostLabel: 'VF · 720p', roomLanguage: 'fr' });
    expect(rows.map((r) => r.label)).toEqual(['VF · 1080p', 'VF · 720p', 'VO EN · 720p']);
    expect(rows.map((r) => r.selected)).toEqual([false, true, false]);
    expect(rows.map((r) => r.badge)).toEqual([null, 'host', 'other']);
    expect(rows[0].meta).toContain('En cache');
  });
  it('textes : hôte, recherche, avertissement, absence de langue', () => {
    expect(hostSourceLine('VF · 1080p')).toBe('Hôte : VF · 1080p');
    expect(hostSourceLine(null)).toBeNull();
    expect(sourceSearchText(0, true)).toBe('Recherche en cours…');
    expect(sourceSearchText(3, false)).toBe('3 sources trouvées');
    expect(sourceLanguageWarning(en720, 'fr', 'FR')).toContain('langue du salon (FR)');
    expect(sourceLanguageWarning(fr1080, 'fr', 'FR')).toBeNull();
    expect(noSourceInRoomLanguage([en720], 'fr')).toBe(true);
    expect(noSourceInRoomLanguage([en720, fr720], 'fr')).toBe(false);
  });
  it('raison du choix : la version de l’hôte (empreinte ou libellé) n’est pas « langue du salon »', () => {
    expect(choiceReason('host')).toBe('Même version que l’hôte du salon');
    expect(choiceReason('fingerprint')).toBe('Même version que l’hôte du salon');
    expect(choiceReason('language')).toBe('Source dans la langue du salon');
  });
});
