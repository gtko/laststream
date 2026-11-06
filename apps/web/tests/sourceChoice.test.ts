// Salon (watch party) : source dans la langue du salon, attente de la langue, avis de repli et de changement de langue.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadSettings, SETTINGS_STORAGE_KEY } from '../src/data/config';
import { clearCache } from '../src/data/transport';
import {
  LANG_WAIT_MS, bestSource, chooseSource, languageChanged, languageFallbackNotice, roomAudioLang, roomLangOf, sourceLabel,
} from '../src/party/sourceChoice';
import { awaitLaunchable, clearSourceCache, loadSources, type LoadedSources, type SourceRequest } from '../src/sources/load';
import { toSourceViews, type SourceView } from '../src/sources/info';
import { isGoodMatch, recommend, type Recommendation } from '../src/sources/rank';

const stream = (n: number, extra: Record<string, unknown> = {}) => ({
  url: 'https://x/play/c/' + n,
  laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 50 + n, estBitrateKbps: 5000, ...extra },
});
const FR_1080 = stream(1);
const FR_720 = stream(2, { resolution: '720p', height: 720 });
const EN_1080 = stream(3, { languages: ['en'] });
/** VF lourde (4K, 60 Mb/s) et VO légère (720p, 1,5 Mb/s) : la VF doit gagner même si le débit est faible. */
const FR_HEAVY = stream(4, { resolution: '2160p', height: 2160, estBitrateKbps: 60000, cached: false, score: 90 });
const EN_LIGHT = stream(5, { resolution: '720p', height: 720, estBitrateKbps: 1500, languages: ['en'], cached: false, score: 10 });

const urlOf = (c: { view: SourceView | null }) => c.view?.stream.url;

describe('chooseSource : ordre des règles', () => {
  it('une VF lourde l’emporte sur une VO légère en salon', () => {
    const c = chooseSource(toSourceViews([EN_LIGHT, FR_HEAVY]), { roomLanguage: 'fr' });
    expect(c.motif).toBe('language');
    expect(urlOf(c)).toBe(FR_HEAVY.url);
  });
  it('le choix explicite du participant passe avant la langue du salon', () => {
    const views = toSourceViews([FR_1080, EN_1080]);
    const c = chooseSource(views, { explicit: views[1], roomLanguage: 'fr' });
    expect(c.motif).toBe('explicit');
    expect(urlOf(c)).toBe(EN_1080.url);
  });
  it('l’empreinte de l’hôte est suivie, même dans une autre langue', () => {
    const views = toSourceViews([FR_1080, EN_1080]).map((v, i) => (i === 1 ? { ...v, filename: 'Film.2024.1080p.EN.mkv' } : v));
    const c = chooseSource(views, { fingerprint: { fileName: 'Film.2024.1080p.EN.mkv', size: null, hash: null }, roomLanguage: 'fr' });
    expect(c.motif).toBe('fingerprint');
    expect(urlOf(c)).toBe(EN_1080.url);
  });
  it('le libellé de l’hôte retient la même langue et la même résolution', () => {
    const c = chooseSource(toSourceViews([FR_720, FR_1080, EN_1080]), { hostLabel: 'VF · 1080p', roomLanguage: 'fr' });
    expect(c.motif).toBe('host');
    expect(urlOf(c)).toBe(FR_1080.url);
  });
  it('un hôte en repli hors de la langue du salon n’entraîne pas un participant qui a une source dans la langue (LAST-1615)', () => {
    const c = chooseSource(toSourceViews([FR_1080, EN_1080]), { hostLabel: 'VO EN · 1080p', roomLanguage: 'fr' });
    expect(c.motif).toBe('language');
    expect(urlOf(c)).toBe(FR_1080.url);
  });
  it('aucune source dans la langue du salon : pas de choix, motif languageFallback', () => {
    expect(chooseSource(toSourceViews([EN_1080]), { roomLanguage: 'fr' })).toEqual({ view: null, motif: 'languageFallback' });
  });
  it('une source non jouable ne compte pas pour la langue du salon', () => {
    const views = toSourceViews([FR_1080, EN_1080]).map((v, i) => (i === 0 ? { ...v, playable: false } : v));
    expect(chooseSource(views, { roomLanguage: 'fr' }).motif).toBe('languageFallback');
  });
  it('aucune source jouable : motif none', () => {
    expect(chooseSource([], { roomLanguage: 'fr' })).toEqual({ view: null, motif: 'none' });
  });
  it('bestSource écarte le son injouable à classement égal', () => {
    const views = toSourceViews([FR_1080, FR_720]).map((v, i) => (i === 0 ? { ...v, appAudio: 'unsupported' as const } : v));
    expect(bestSource(views)?.stream.url).toBe(FR_720.url);
  });
});

describe('libellés et avis', () => {
  it('sourceLabel : langue puis résolution', () => {
    expect(sourceLabel(toSourceViews([FR_1080])[0])).toBe('VF · 1080p');
    expect(sourceLabel(toSourceViews([EN_1080])[0])).toBe('VO EN · 1080p');
  });
  it('avis de repli : langue du salon et langue réellement lue', () => {
    expect(languageFallbackNotice(toSourceViews([EN_1080])[0], 'fr')).toBe('Pas de source en Français : lecture en VO EN');
  });
  it('changement de langue signalé seulement en salon, hors de sa langue', () => {
    const [fr, en] = toSourceViews([FR_1080, EN_1080]);
    expect(languageChanged(en, 'fr')).toBe(true);
    expect(languageChanged(fr, 'fr')).toBe(false);
    expect(languageChanged(en, null)).toBe(false);
  });
});

describe('langue du salon', () => {
  it('code du salon vers langue des sources, et piste audio à viser', () => {
    expect(roomLangOf('fr')).toBe('fr');
    expect(roomLangOf('vo', 'ja')).toBe('original');
    expect(roomLangOf('ja', 'ja')).toBe('original');
    expect(roomLangOf('ko', 'ja')).toBe('multi');
    expect(roomLangOf(undefined)).toBeNull();
    // Source MULTI en salon : la piste de la langue du salon ; « vo » : la langue d'origine du titre ; rien sans langue.
    expect(roomAudioLang('fr', 'ja')).toBe('fr');
    expect(roomAudioLang('vo', 'ja')).toBe('ja');
    expect(roomAudioLang('vo', '')).toBeUndefined();
    expect(roomAudioLang(undefined, 'ja')).toBeUndefined();
  });
});

const REQ: SourceRequest = { type: 'movie', id: '1', name: 'Film', key: 'movie:1', imdb: 'tt0000001' };

interface SimAddon {
  name: string;
  /** Instant (ms depuis le début du test) où l'addon répond. */
  at: number;
  streams: unknown[];
}

/** Faux lastAddon à horloge simulée : un addon dont l'instant de réponse est passé apparaît dans la liste. */
function simulatedAddons(addons: SimAddon[]) {
  const start = Date.now();
  const elapsed = () => Date.now() - start;
  const state = () => {
    const done = addons.filter((a) => elapsed() >= a.at);
    return { streams: done.flatMap((a) => a.streams), pending: addons.filter((a) => elapsed() < a.at).map((a) => a.name) };
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const s = state();
    if (url.includes('/lt/streams/status/')) return new Response(JSON.stringify({ pending: s.pending, count: s.streams.length }), { status: 200 });
    return new Response(JSON.stringify({ streams: s.streams, ...(s.pending.length ? { pending: s.pending } : {}) }), { status: 200 });
  }));
  return { start };
}

const readable = (views: readonly SourceView[]) => views.some((v) => v.playable && !v.client);

/** Recommandation salon : langue du salon « fr » d'abord, sinon la meilleure dans une autre langue, avec avis (comme searchAndPlay). */
const roomRec = (views: readonly SourceView[]): Recommendation | null => {
  const c = chooseSource(views, { roomLanguage: 'fr' });
  if (c.view) return { view: c.view, languageFallback: false, reason: 'Source en français' };
  const best = bestSource(views);
  return best ? { view: best, languageFallback: true, reason: languageFallbackNotice(best, 'fr') } : null;
};

async function launchAt(first: LoadedSources, start: number, pick: (v: readonly SourceView[]) => Recommendation | null, fallbackWaitMs?: number) {
  let doneAt = -1;
  const promise = awaitLaunchable(first, {
    request: REQ, since: start, readable, recommend: pick, good: (r) => isGoodMatch(r), fallbackWaitMs,
  }).then((choice) => {
    doneAt = Date.now() - start;
    return choice;
  });
  await vi.advanceTimersByTimeAsync(12_000);
  return { choice: await promise, doneAt };
}

describe('attente de la langue du salon (awaitLaunchable)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ base: 'http://localhost:7000', config: 'CFG' }));
    reloadSettings();
    clearCache();
    clearSourceCache();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('salon : une VF lente (répond à 5 s) est attendue au-delà de la grâce de 2,5 s', async () => {
    const sim = simulatedAddons([
      { name: 'C411', at: 0, streams: [EN_LIGHT] },
      { name: 'YGG', at: 5_000, streams: [FR_1080] },
    ]);
    const first = await loadSources(REQ);
    const { choice, doneAt } = await launchAt(first, sim.start, roomRec, LANG_WAIT_MS);
    expect(choice.rec?.view.stream.url).toBe(FR_1080.url);
    expect(doneAt).toBeGreaterThanOrEqual(5_000);
    expect(doneAt).toBeLessThan(8_000);
  });

  it('hors salon : la VO part après la grâce de 2,5 s, sans attendre la VF lente', async () => {
    const sim = simulatedAddons([
      { name: 'C411', at: 0, streams: [EN_LIGHT] },
      { name: 'YGG', at: 5_000, streams: [FR_1080] },
    ]);
    const first = await loadSources(REQ);
    const { choice, doneAt } = await launchAt(first, sim.start, (v) => recommend(v, null, 'fr'));
    expect(choice.rec?.view.stream.url).toBe(EN_LIGHT.url);
    expect(doneAt).toBeLessThan(3_000);
  });
});
