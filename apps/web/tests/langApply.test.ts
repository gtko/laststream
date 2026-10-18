// Application des langues du profil aux moteurs : mpv (aid / sid / secondary-sid), natif Android, double sous-titres HTML5,
// réglages (sérialisation, synchronisation avec le compte) et classement des sources en mode apprentissage.
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LANG_PREFS, getLangPrefs, hasStoredLangPrefs, legacyLangPrefs, normalizeLangPrefs, setLangPrefs, wantedSubLang, LANG_PREFS_KEY, type LangPrefs } from '../src/data/langPrefs';
import { setVideoLang } from '../src/data/prefs';
import { applyPrefs, snapshotPrefs } from '../src/data/prefsSync';
import { MpvEngine, NativeEngine } from '../src/player/engines.js';
import { MiniState } from '../src/player/mini';
import { nativeAudioTracks, nativeSubtitleTracks, toNativeSubtitles } from '../src/player/native';
import { TrackApplier, type TrackSink } from '../src/player/trackApply';
import { createPlayerUI } from '../src/player/ui.js';
import { writeSubStyle, DEFAULT_SUB_STYLE } from '../src/player/subs';
import { recommend } from '../src/sources/rank';
import { toSourceViews } from '../src/sources/info';
import type { Stream } from '../src/data/stream';

const prefs = (over: Partial<LangPrefs> = {}): LangPrefs => ({ ...DEFAULT_LANG_PREFS, ...over });

beforeEach(() => { localStorage.clear(); });

// ---------- mpv ----------

function mpvSetup() {
  const sent: Array<[string, unknown]> = [];
  const handlers = new Map<string, (a: unknown) => void>();
  const ipc = { send: (e: string, a?: unknown) => sent.push([e, a]), on: (e: string, fn: (a: unknown) => void) => { handlers.set(e, fn); } };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const engine = new MpvEngine(ipc, container);
  (engine as unknown as { live: boolean }).live = true;
  const emit = (name: string, data: unknown) => handlers.get('mpv-prop-change')!({ name, data });
  const sink: TrackSink = {
    setAudio: (id) => engine.setAudioTrack(id),
    setSub: (id) => engine.setSubtitleTrack(id),
    setSecondary: (id) => engine.setSecondarySubtitleTrack(id),
  };
  const props = (name: string) => sent.filter(([e, a]) => e === 'mpv-set-prop' && (a as unknown[])[0] === name).map(([, a]) => (a as unknown[])[1]);
  return { sent, engine, emit, sink, props };
}

const TRACKS = [
  { id: 1, type: 'audio', lang: 'jpn', selected: true, 'audio-channels': 6 },
  { id: 2, type: 'audio', lang: 'eng', selected: false, 'audio-channels': 6 },
  { id: 1, type: 'sub', lang: 'eng', selected: false, codec: 'subrip' },
  { id: 2, type: 'sub', lang: 'fre', selected: false, codec: 'subrip' },
  { id: 3, type: 'sub', lang: 'fre', selected: false, codec: 'subrip', forced: true },
];

describe('mpv : application des langues', () => {
  it('ne renvoie sid / aid / secondary-sid qu’une fois, même si la liste de pistes est ré-annoncée', () => {
    const { engine, emit, sink, props } = mpvSetup();
    const applier = new TrackApplier();
    emit('track-list', TRACKS);
    const learn = prefs({ learn: true, learnLang: 'en' });
    const ctx = { canSecondary: () => true };
    const pick = applier.apply(engine.audioTracks(), engine.subtitleTracks(), learn, ctx, sink);
    expect(pick).toMatchObject({ audioId: '2', subId: '1', secondarySubId: '2' });
    expect(props('aid')).toEqual([2]);
    expect(props('sid')).toEqual([1]);
    expect(props('secondary-sid')).toEqual([2]);
    // Annonces suivantes : rien de plus.
    emit('track-list', TRACKS);
    expect(applier.apply(engine.audioTracks(), engine.subtitleTracks(), learn, ctx, sink)).toBeNull();
    expect(applier.late(engine.audioTracks(), engine.subtitleTracks(), learn, ctx, sink)).toBeNull();
    expect(props('aid')).toHaveLength(1);
    expect(props('sid')).toHaveLength(1);
    expect(props('secondary-sid')).toHaveLength(1);
  });

  it('VO japonaise + sous-titres français : aid inchangé (déjà sélectionné), sid français, pas de second sous-titre', () => {
    const { engine, emit, sink, props } = mpvSetup();
    emit('track-list', TRACKS);
    const applier = new TrackApplier();
    applier.apply(engine.audioTracks(), engine.subtitleTracks(), prefs(), { originalLang: 'ja' }, sink);
    expect(props('aid')).toEqual([]);
    expect(props('sid')).toEqual([2]);
    expect(props('secondary-sid')).toEqual([]);
  });

  it('un choix manuel avant l’arrivée des pistes prime : rien n’est appliqué', () => {
    const { engine, emit, sink, sent } = mpvSetup();
    const applier = new TrackApplier();
    applier.markManual();
    emit('track-list', TRACKS);
    const before = sent.length;
    expect(applier.apply(engine.audioTracks(), engine.subtitleTracks(), prefs(), {}, sink)).toBeNull();
    expect(sent.length).toBe(before);
  });

  it('un choix manuel après l’application bloque les sous-titres arrivés ensuite', () => {
    const { engine, emit, sink, props } = mpvSetup();
    const applier = new TrackApplier();
    emit('track-list', [TRACKS[0], TRACKS[1]]); // aucun sous-titre dans le fichier
    applier.apply(engine.audioTracks(), engine.subtitleTracks(), prefs(), {}, sink);
    applier.markManual();
    emit('track-list', TRACKS);
    expect(applier.late(engine.audioTracks(), engine.subtitleTracks(), prefs(), {}, sink)).toBeNull();
    expect(props('sid')).toEqual([]);
  });

  it('sous-titres externes chargés après coup : appliqués une seule fois', () => {
    const { engine, emit, sink, props } = mpvSetup();
    const applier = new TrackApplier();
    emit('track-list', [TRACKS[0], TRACKS[1]]);
    applier.apply(engine.audioTracks(), engine.subtitleTracks(), prefs(), {}, sink);
    const ext = { id: 'e1', title: '', lang: 'fr', label: 'Français', codec: 'srt', forced: false, origin: 'external' as const, renderable: true, url: 'http://x/fr.srt', selected: false };
    const picked: Array<string | null> = [];
    const sink2: TrackSink = { ...sink, setSub: (id) => { picked.push(id); } };
    expect(applier.late(engine.audioTracks(), [ext], prefs(), {}, sink2)).toMatchObject({ subId: 'e1' });
    expect(applier.late(engine.audioTracks(), [ext], prefs(), {}, sink2)).toBeNull();
    expect(picked).toEqual(['e1']);
    expect(props('sid')).toEqual([]);
  });

  it('apprentissage : le second sous-titre externe arrive après coup', () => {
    const { engine, emit, sink } = mpvSetup();
    const applier = new TrackApplier();
    emit('track-list', [TRACKS[0], TRACKS[1], TRACKS[2]]); // seulement l’anglais interne
    const learn = prefs({ learn: true });
    const sec: string[] = [];
    const sink2: TrackSink = { ...sink, setSecondary: (id) => { sec.push(String(id)); } };
    const ctx = { canSecondary: (t: { url?: string }) => !!t.url };
    expect(applier.apply(engine.audioTracks(), engine.subtitleTracks(), learn, ctx, sink2)).toMatchObject({ subId: '1', secondarySubId: null });
    const ext = { id: 'e1', title: '', lang: 'fr', label: 'Français', codec: 'srt', forced: false, origin: 'external' as const, renderable: true, url: 'http://x/fr.srt', selected: false };
    const all = [...engine.subtitleTracks(), ext];
    expect(applier.late(engine.audioTracks(), all, learn, ctx, sink2)).toMatchObject({ subId: '1', secondarySubId: 'e1' });
    expect(sec).toEqual(['e1']);
  });

  it('au chargement d’un fichier, le second sous-titre repart de zéro', async () => {
    const { engine, sent, emit } = mpvSetup();
    emit('mpv-version', 'mpv 0.39.0');
    await engine.load({ url: 'http://127.0.0.1:11470/abc/2', startAt: 0 });
    expect(sent).toContainEqual(['mpv-set-prop', ['secondary-sid', 'no']]);
    engine.setSecondarySubtitleTrack(null);
    expect(sent.filter(([, a]) => (a as unknown[])?.[0] === 'secondary-sid').pop()).toEqual(['mpv-set-prop', ['secondary-sid', 'no']]);
  });
});

// ---------- Android natif ----------

describe('Android natif : audio + un seul sous-titre', () => {
  const nativeAudio = nativeAudioTracks([{ id: 10, label: 'Japonais', lang: 'jpn', selected: true }, { id: 11, label: 'Anglais', lang: 'eng', selected: false }]);
  const nativeSubs = nativeSubtitleTracks([{ id: 20, label: 'Anglais', lang: 'eng', selected: false }, { id: 21, label: 'Français', lang: 'fre', selected: false }]);

  it('mode apprentissage : langue apprise seule (pas de second sous-titre)', () => {
    const calls: string[] = [];
    const sink: TrackSink = { setAudio: (id) => calls.push('a' + id), setSub: (id) => calls.push('s' + id), setSecondary: (id) => calls.push('2' + id) };
    const applier = new TrackApplier();
    const pick = applier.apply(nativeAudio, nativeSubs, prefs({ learn: true }), { canSecondary: () => false }, sink, true);
    expect(pick).toMatchObject({ audioId: '11', subId: '20', secondarySubId: null });
    expect(calls).toEqual(['a11', 's20']);
  });

  it('le lecteur natif reçoit les sous-titres externes de la langue voulue', () => {
    const ext = ['fr', 'en', 'de'].map((lang) => ({ id: 'x' + lang, title: '', lang, label: lang, codec: 'srt', forced: false, origin: 'external' as const, renderable: true, url: 'http://x/' + lang, selected: false }));
    expect(toNativeSubtitles(ext, wantedSubLang(prefs({ learn: true, learnLang: 'de' }))).map((t) => t.lang)).toEqual(['de', 'en']);
  });

  it('NativeEngine expose les pistes du plugin et refuse le second sous-titre', () => {
    const plugin = { addListener: () => Promise.resolve({ remove: () => undefined }), setAudioTrack: () => Promise.resolve(), setSubtitleTrack: () => Promise.resolve() };
    const e = new NativeEngine(plugin);
    expect(e.supportsSecondary()).toBe(false);
  });
});

// ---------- HTML5 : double sous-titres ----------

describe('HTML5 / HLS : rendu des double sous-titres', () => {
  function ui(): PlayerUI {
    const storage = new Map<string, string>();
    const miniState = new MiniState({ getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); } });
    current = createPlayerUI({ miniState, action: () => undefined, miniLayout: () => undefined, panelOpened: () => undefined, panelClosed: () => undefined, thumb: () => undefined, thumbCancel: () => undefined });
    return current;
  }
  type PlayerUI = { root: HTMLElement; setCue(html: string, style: typeof DEFAULT_SUB_STYLE, bottom?: string): void };
  let current: PlayerUI;
  const subs = () => current.root.querySelector('.lp-subs') as HTMLElement;

  it('un seul sous-titre : une ligne, comme avant', () => {
    const p = ui();
    p.setCue('Bonjour', DEFAULT_SUB_STYLE);
    expect(subs().querySelectorAll('span')).toHaveLength(1);
    expect(subs().classList.contains('is-dual')).toBe(false);
    expect(subs().textContent).toBe('Bonjour');
  });

  it('deux sous-titres : langue apprise en haut, français dessous', () => {
    const p = ui();
    p.setCue('Hello there', DEFAULT_SUB_STYLE, 'Bonjour');
    const lines = Array.from(subs().querySelectorAll('span'));
    expect(subs().classList.contains('is-dual')).toBe(true);
    expect(lines.map((l) => l.className)).toEqual(['lp-sub-top', 'lp-sub-bot']);
    expect(lines.map((l) => l.textContent)).toEqual(['Hello there', 'Bonjour']);
    // Le style des sous-titres (couleur, fond) s’applique aux deux lignes.
    p.setCue('Hello there', { ...DEFAULT_SUB_STYLE, color: 'yellow', background: 'box' }, 'Bonjour');
    expect(subs().className).toContain('c-yellow');
    expect(subs().className).toContain('bg-box');
  });

  it('si une seule des deux lignes est active, elle s’affiche seule', () => {
    const p = ui();
    p.setCue('', DEFAULT_SUB_STYLE, 'Bonjour');
    expect(subs().querySelectorAll('span')).toHaveLength(1);
    expect(subs().textContent).toBe('Bonjour');
    p.setCue('', DEFAULT_SUB_STYLE, '');
    expect(subs().innerHTML).toBe('');
  });

  it('le texte reste échappé (le HTML des cues vient de cueHtml)', () => {
    const p = ui();
    p.setCue('<i>Hi</i>', DEFAULT_SUB_STYLE, 'Salut');
    expect(subs().querySelector('.lp-sub-top i')).not.toBeNull();
  });
});

// ---------- Réglages ----------

describe('réglages de langue du profil', () => {
  it('valeurs par défaut : audio français, VO en secours, sous-titres activés, apprentissage coupé', () => {
    expect(getLangPrefs()).toEqual({ audio: 'fr', audio2: 'vo', subsOn: true, subs: 'main', learn: false, learnLang: 'en' });
    expect(hasStoredLangPrefs()).toBe(false);
  });

  it('sérialise, relit et normalise (codes à trois lettres, valeurs inconnues ignorées)', () => {
    setLangPrefs({ audio: 'fre', audio2: 'jpn', learn: true, learnLang: 'eng', subs: 'ger' });
    expect(JSON.parse(localStorage.getItem(LANG_PREFS_KEY)!)).toEqual({ audio: 'fr', audio2: 'ja', subsOn: true, subs: 'de', learn: true, learnLang: 'en' });
    expect(normalizeLangPrefs({ audio: 'klingon', audio2: 42, subsOn: 'oui', learn: null })).toEqual(DEFAULT_LANG_PREFS);
    expect(normalizeLangPrefs('n’importe quoi')).toEqual(DEFAULT_LANG_PREFS);
    expect(setLangPrefs({ audio2: 'none' }).audio2).toBe('none');
  });

  it('JSON illisible : défauts', () => {
    localStorage.setItem(LANG_PREFS_KEY, '{pas du json');
    expect(getLangPrefs()).toEqual(DEFAULT_LANG_PREFS);
  });

  it('migre l’ancien réglage : langue des bandes-annonces et « Jamais » du panneau du lecteur', () => {
    setVideoLang('en');
    writeSubStyle({ ...DEFAULT_SUB_STYLE, mode: 'off' });
    expect(legacyLangPrefs()).toMatchObject({ audio: 'en', subsOn: false });
    expect(getLangPrefs()).toMatchObject({ audio: 'en', subsOn: false });
    // Dès qu’un réglage est enregistré, il devient la source de vérité.
    setLangPrefs({ audio: 'fr' });
    expect(getLangPrefs()).toMatchObject({ audio: 'fr', subsOn: false });
  });

  it('synchronisation avec le compte : instantané, sous la limite de 4 Ko, et rechargement', () => {
    setLangPrefs({ audio: 'ja', learn: true, learnLang: 'ko', subs: 'en', subsOn: false });
    const snap = snapshotPrefs();
    expect(snap.langPrefs).toEqual({ audio: 'ja', audio2: 'vo', subsOn: false, subs: 'en', learn: true, learnLang: 'ko' });
    expect(new TextEncoder().encode(JSON.stringify(snap.langPrefs)).length).toBeLessThan(4096);
    localStorage.clear();
    expect(applyPrefs({ langPrefs: snap.langPrefs })).toBe(true);
    expect(getLangPrefs()).toEqual(snap.langPrefs);
    // Une valeur corrompue côté compte ne casse rien.
    applyPrefs({ langPrefs: { audio: 'xx', learn: 'oui' } });
    expect(getLangPrefs()).toEqual(DEFAULT_LANG_PREFS);
    expect(applyPrefs({ langPrefs: 'texte' })).toBe(false);
  });

  it('langue des sous-titres recherchés', () => {
    expect(wantedSubLang(prefs())).toBe('fr');
    expect(wantedSubLang(prefs({ subs: 'en' }))).toBe('en');
    expect(wantedSubLang(prefs({ learn: true, learnLang: 'ja' }))).toBe('ja');
  });
});

// ---------- Classement des sources ----------

describe('classement des sources selon les langues', () => {
  const mk = (languages: string[], score: number, over: Record<string, unknown> = {}): Stream => ({
    url: 'https://x/play/' + languages.join('') + score,
    laststream: { resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages, cached: true, score, estBitrateKbps: 8000, ...over },
  } as unknown as Stream);
  const views = () => toSourceViews([mk(['original'], 90, { languageFallback: true }), mk(['fr'], 60), mk(['multi'], 50)]);

  it('français par défaut : la VF passe devant la VO mieux notée', () => {
    const r = recommend(views(), null, 'fr', { preferDirect: false });
    expect(r?.view.langs.map((l) => l.label.toLowerCase()).join()).toMatch(/fr|vf/);
    expect(r?.languageFallback).toBe(false);
  });

  it('apprentissage de l’anglais : la VO n’est pas pénalisée ni présentée comme un repli', () => {
    const r = recommend(views(), null, 'en', { preferDirect: false, alsoAccept: ['original', 'multi'] });
    expect(r?.view.score).toBe(90);
    expect(r?.languageFallback).toBe(false);
    const web = recommend(views(), null, 'en', { preferDirect: true, alsoAccept: ['original', 'multi'] });
    expect(web?.languageFallback).toBe(false);
  });

  it('sans le mode apprentissage, la même VO reste un repli', () => {
    const r = recommend(toSourceViews([mk(['original'], 90, { languageFallback: true })]), null, 'en', { preferDirect: false });
    expect(r?.languageFallback).toBe(true);
  });
});
