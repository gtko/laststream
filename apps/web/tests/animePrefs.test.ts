import { afterEach, describe, expect, it } from 'vitest';
import { isAnime } from '../src/data/anime';
import { DEFAULT_LANG_PREFS, getLangPrefs, LANG_PREFS_KEY, normalizeLangPrefs, resolveLangPrefs, setAnimePrefs, type AnimePrefs, type LangPrefs } from '../src/data/langPrefs';
import type { Stream } from '../src/data/stream';
import { pickTracks } from '../src/player/langPolicy';
import { trackLang, type AudioTrack, type SubtitleTrack } from '../src/player/tracks';
import { toSourceViews } from '../src/sources/info';
import { audioLangsFor, recommendFor, sourceLangFor } from '../src/sources/load';

const a = (id: string, lang: string, over: Partial<AudioTrack> = {}): AudioTrack => ({
  id, lang: trackLang(lang, over.title), title: '', codec: 'eac3', channels: 6, selected: false, label: id, ...over,
});
const s = (id: string, lang: string, over: Partial<SubtitleTrack> = {}): SubtitleTrack => ({
  id, lang: trackLang(lang, over.title), title: '', codec: 'subrip', forced: false, origin: 'embedded', renderable: true, selected: false, label: id, ...over,
});
/** Réglages généraux (français, sous-titres hors langue principale) avec la section Anime activée. */
const withAnime = (anime: Partial<AnimePrefs>, over: Partial<LangPrefs> = {}): LangPrefs => ({
  ...DEFAULT_LANG_PREFS, ...over, anime: { ...DEFAULT_LANG_PREFS.anime, on: true, ...anime },
});

describe('détection d\'un anime', () => {
  it('Animation + langue japonaise, ou Animation + pays JP', () => {
    expect(isAnime({ genreIds: [16, 35], originalLanguage: 'ja' })).toBe(true);
    expect(isAnime({ genreIds: [16], originalLanguage: 'en', originCountry: ['JP'] })).toBe(true);
  });
  it('pas un anime : animation occidentale, film japonais en prises de vues réelles, données absentes', () => {
    expect(isAnime({ genreIds: [16], originalLanguage: 'en', originCountry: ['US'] })).toBe(false);
    expect(isAnime({ genreIds: [18], originalLanguage: 'ja', originCountry: ['JP'] })).toBe(false);
    expect(isAnime({})).toBe(false);
    expect(isAnime(null)).toBe(false);
  });
});

describe('réglages Anime : stockage', () => {
  afterEach(() => localStorage.clear());

  it('désactivés par défaut ; valeurs inconnues ignorées', () => {
    expect(DEFAULT_LANG_PREFS.anime.on).toBe(false);
    const n = normalizeLangPrefs({ anime: { on: true, audio: 'klingon', subs: 'forced', ifForeign: 'oui' } });
    expect(n.anime).toEqual({ on: true, audio: DEFAULT_LANG_PREFS.anime.audio, subs: 'forced', ifForeign: true });
  });

  it('anciens réglages sans section Anime : valeurs par défaut', () => {
    localStorage.setItem(LANG_PREFS_KEY, JSON.stringify({ audio: 'fr', learn: false }));
    expect(getLangPrefs().anime).toEqual(DEFAULT_LANG_PREFS.anime);
  });

  it('setAnimePrefs fusionne sans toucher aux réglages généraux', () => {
    localStorage.setItem(LANG_PREFS_KEY, JSON.stringify({ audio: 'en', subsOn: false }));
    setAnimePrefs({ on: true, audio: 'fr' });
    const lp = getLangPrefs();
    expect(lp).toMatchObject({ audio: 'en', subsOn: false, anime: { on: true, audio: 'fr', subs: 'fr', ifForeign: true } });
  });
});

describe('réglages effectifs (resolveLangPrefs)', () => {
  it('non-anime, ou section désactivée : les réglages généraux, tels quels', () => {
    const lp = withAnime({});
    expect(resolveLangPrefs(lp, false)).toBe(lp);
    const off = withAnime({ on: false });
    expect(resolveLangPrefs(off, true)).toBe(off);
  });

  it('anime : audio et sous-titres de la section, mode apprentissage ignoré', () => {
    const r = resolveLangPrefs(withAnime({ audio: 'ja', subs: 'fr' }, { learn: true, learnLang: 'en' }), true);
    expect(r).toMatchObject({ audio: 'ja', audio2: 'fr', subsOn: true, subs: 'fr', learn: false, native: 'fr', subsAlways: false, forcedOnly: false, noSubs: false });
  });
});

describe('pickTracks : anime', () => {
  const both = [a('vo', 'jpn', { selected: true }), a('vf', 'fre', { title: 'VFF' })];
  const subs = [s('sfr', 'fre'), s('sfrf', 'fre', { forced: true }), s('sen', 'eng')];

  it('VF + VO, préférence VO sous-titrée français : audio japonais, sous-titres français', () => {
    const r = pickTracks(both, subs, resolveLangPrefs(withAnime({ audio: 'ja', subs: 'fr' }), true));
    expect(r).toMatchObject({ audioId: 'vo', subId: 'sfr', audioLang: 'ja' });
  });

  it('VF + VO, préférence VF : audio français, pas de sous-titres complets (forcés seulement)', () => {
    const r = pickTracks(both, subs, resolveLangPrefs(withAnime({ audio: 'fr', subs: 'fr' }, { audio: 'fr' }), true));
    expect(r).toMatchObject({ audioId: 'vf', subId: 'sfrf', audioLang: 'fr' });
  });

  it('indépendant des réglages généraux : général en VO + sous-titres anglais, anime en VF', () => {
    const general = { audio: 'en', audio2: 'vo', subs: 'en' };
    const lp = withAnime({ audio: 'fr', subs: 'none' }, general);
    const tracks = [a('en', 'eng'), a('vf', 'fre')];
    expect(pickTracks(tracks, subs, resolveLangPrefs(lp, true))).toMatchObject({ audioId: 'vf', subId: null });
    // Non-anime : les réglages généraux (audio anglais) restent seuls en vigueur.
    expect(pickTracks(tracks, subs, resolveLangPrefs(lp, false))).toMatchObject({ audioId: 'en' });
  });

  it('VO seule, préférence VF : repli sur les réglages généraux (VO sous-titrée français)', () => {
    const r = pickTracks([a('vo', 'jpn', { selected: true })], subs, resolveLangPrefs(withAnime({ audio: 'fr', subs: 'fr' }), true));
    expect(r).toMatchObject({ audioId: 'vo', subId: 'sfr', audioLang: 'ja' });
  });

  it('VO seule, préférence VO : sous-titres français', () => {
    const r = pickTracks([a('vo', 'jpn')], subs, resolveLangPrefs(withAnime({ audio: 'ja', subs: 'fr' }), true));
    expect(r).toMatchObject({ audioId: 'vo', subId: 'sfr' });
  });

  it('sans sous-titres français : aucun sous-titre inventé (la langue demandée seule)', () => {
    const r = pickTracks([a('vo', 'jpn')], [s('sen', 'eng')], resolveLangPrefs(withAnime({ audio: 'ja', subs: 'fr' }), true));
    expect(r).toMatchObject({ audioId: 'vo', subId: null });
  });

  it('sous-titres anglais demandés sur de l\'audio japonais', () => {
    const r = pickTracks(both, subs, resolveLangPrefs(withAnime({ audio: 'ja', subs: 'en' }), true));
    expect(r).toMatchObject({ audioId: 'vo', subId: 'sen' });
  });

  it('« Aucun » : jamais de sous-titres, même forcés', () => {
    const r = pickTracks(both, subs, resolveLangPrefs(withAnime({ audio: 'ja', subs: 'none' }), true));
    expect(r).toMatchObject({ audioId: 'vo', subId: null });
  });

  it('« Forcés seulement » : la piste forcée de ma langue, même sur de l\'audio japonais', () => {
    const r = pickTracks(both, subs, resolveLangPrefs(withAnime({ audio: 'ja', subs: 'forced' }), true));
    expect(r).toMatchObject({ audioId: 'vo', subId: 'sfrf' });
  });

  it('« seulement si l\'audio n\'est pas dans ma langue » désactivé : sous-titres même en VF', () => {
    const lp = resolveLangPrefs(withAnime({ audio: 'fr', subs: 'fr', ifForeign: false }), true);
    expect(pickTracks(both, subs, lp)).toMatchObject({ audioId: 'vf', subId: 'sfr' });
  });

  it('langue d\'origine : la langue d\'origine du titre, sinon repli', () => {
    const lp = resolveLangPrefs(withAnime({ audio: 'vo', subs: 'fr' }), true);
    expect(pickTracks(both, subs, lp, { originalLang: 'ja' })).toMatchObject({ audioId: 'vo', subId: 'sfr' });
  });

  it('choix manuel mémorisé pour le titre : prime sur la section Anime', () => {
    const lp = resolveLangPrefs(withAnime({ audio: 'ja', subs: 'fr' }), true);
    expect(pickTracks(both, subs, lp, { rememberedAudio: 'fr', rememberedSub: 'off' })).toMatchObject({ audioId: 'vf', subId: null });
  });

  it('non-anime : comportement général inchangé (VF, forcés seulement)', () => {
    const lp = withAnime({ audio: 'ja', subs: 'fr' });
    expect(pickTracks(both, subs, resolveLangPrefs(lp, false))).toMatchObject({ audioId: 'vf', subId: 'sfrf' });
  });
});

describe('classement des sources : anime', () => {
  afterEach(() => localStorage.clear());
  const mk = (languages: string[]): Stream => ({
    url: 'https://x/play/' + languages.join('-'),
    laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages, cached: true, score: 50, estBitrateKbps: 8000 },
  });

  it('langue de classement : VF pour « fr », VO pour « ja » ou langue d\'origine, anglais pour « en »', () => {
    expect(sourceLangFor(resolveLangPrefs(withAnime({ audio: 'fr' }), true))).toBe('fr');
    expect(sourceLangFor(resolveLangPrefs(withAnime({ audio: 'ja' }), true))).toBe('original');
    expect(sourceLangFor(resolveLangPrefs(withAnime({ audio: 'vo' }), true))).toBe('original');
    expect(sourceLangFor(resolveLangPrefs(withAnime({ audio: 'en' }), true))).toBe('en');
    // Non-anime : réglage général (français).
    expect(sourceLangFor(resolveLangPrefs(withAnime({ audio: 'ja' }), false))).toBe('fr');
    expect(audioLangsFor(resolveLangPrefs(withAnime({ audio: 'en' }), true), undefined, 'ja')).toEqual(['en']);
  });

  it('la source en VO passe devant la VF pour un anime en VO, et inversement ; l\'autre reste proposée', () => {
    const views = toSourceViews([mk(['fr']), mk(['original'])]);
    const vo = recommendFor(views, null, 'ja', undefined, resolveLangPrefs(withAnime({ audio: 'ja' }), true));
    const vf = recommendFor(views, null, 'ja', undefined, resolveLangPrefs(withAnime({ audio: 'fr' }), true));
    expect(vo!.reason).toMatch(/^Meilleure VO/);
    expect(vf!.reason).toMatch(/^Meilleure VF/);
    expect(views).toHaveLength(2);
  });
});
