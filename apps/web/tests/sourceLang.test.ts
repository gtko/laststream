import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LANG_PREFS, LANG_PREFS_KEY, LANG_VO, type LangPrefs } from '../src/data/langPrefs';
import type { Stream } from '../src/data/stream';
import { toSourceViews } from '../src/sources/info';
import { audioLangsFor, recommendFor, sourceLangFor } from '../src/sources/load';

const mk = (over: Record<string, unknown> = {}): Stream => ({
  url: 'https://x/play/abc',
  laststream: {
    resolution: '1080p', height: 1080, source: 'WEB-DL', codec: 'AVC', hdr: [], languages: ['fr'], cached: true, score: 50,
    estBitrateKbps: 8000, ...over,
  },
});

/** Mode apprentissage : langue apprise `learnLang`, audio principal `audio`. */
const learn = (learnLang: string, audio = 'fr'): LangPrefs => ({ ...DEFAULT_LANG_PREFS, audio, learn: true, learnLang });

describe('langue de classement des sources (sourceLangFor)', () => {
  it('langue apprise non gérée (ja) : version originale si le titre est japonais', () => {
    expect(sourceLangFor(learn('ja'), 'ja')).toBe('original');
    expect(sourceLangFor(learn('ja'), ' JA ')).toBe('original');
  });

  it('langue apprise non gérée (ko) : multi-audio si le titre est dans une autre langue', () => {
    expect(sourceLangFor(learn('ko'), 'en')).toBe('multi');
  });

  it('langue apprise non gérée, origine inconnue : multi-audio', () => {
    expect(sourceLangFor(learn('ko'))).toBe('multi');
  });

  it('langue apprise gérée : elle-même, quelle que soit la langue d\'origine', () => {
    expect(sourceLangFor(learn('en'), 'ja')).toBe('en');
    expect(sourceLangFor(learn('en'))).toBe('en');
  });

  it('version originale : original', () => {
    expect(sourceLangFor({ ...DEFAULT_LANG_PREFS, audio: LANG_VO })).toBe('original');
  });

  it('langue principale non gérée hors apprentissage : original, comme avant', () => {
    expect(sourceLangFor({ ...DEFAULT_LANG_PREFS, audio: 'ja' })).toBe('original');
    expect(sourceLangFor({ ...DEFAULT_LANG_PREFS, audio: 'ja' }, 'ja')).toBe('original');
  });

  it('langue principale gérée : elle-même', () => {
    expect(sourceLangFor({ ...DEFAULT_LANG_PREFS, audio: 'de' })).toBe('de');
  });
});

describe('langues audio visées sur les pistes (audioLangsFor)', () => {
  it('mode apprentissage : le code de la langue apprise, jamais « original » ni « multi »', () => {
    expect(audioLangsFor(learn('ja'), undefined, 'ja')).toEqual(['ja']);
    expect(audioLangsFor(learn('ko'), undefined, 'en')).toEqual(['ko']);
    expect(audioLangsFor(learn('zh'))).toEqual(['zh']);
    expect(audioLangsFor(learn('en'), undefined, 'ja')).toEqual(['en']);
  });

  it('le choix mémorisé pour le titre passe devant', () => {
    expect(audioLangsFor(learn('ja'), 'fr')).toEqual(['fr', 'ja']);
  });

  it('hors apprentissage : inchangé (langue gérée, sinon original)', () => {
    expect(audioLangsFor({ ...DEFAULT_LANG_PREFS, audio: 'de' })).toEqual(['de']);
    expect(audioLangsFor({ ...DEFAULT_LANG_PREFS, audio: 'ja' }, undefined, 'ja')).toEqual(['original']);
    expect(audioLangsFor({ ...DEFAULT_LANG_PREFS, audio: LANG_VO })).toEqual(['original']);
    expect(audioLangsFor({ ...DEFAULT_LANG_PREFS, learn: false, learnLang: 'ja' })).toEqual(['fr']);
  });

  it('langue apprise = langue principale : classement habituel', () => {
    expect(audioLangsFor(learn('fr', 'fr'))).toEqual(['fr']);
  });
});

describe('recommandation : la langue d\'origine du titre est transmise au classement', () => {
  afterEach(() => localStorage.clear());

  it('langue apprise non gérée : la source en VO est visée si le titre est dans cette langue, sinon le multi-audio', () => {
    localStorage.setItem(LANG_PREFS_KEY, JSON.stringify({ audio: 'fr', learn: true, learnLang: 'ko' }));
    const views = toSourceViews([mk({ languages: ['multi'] })]);
    expect(recommendFor(views, null, 'ko')!.reason).toMatch(/^Meilleure VO/);
    expect(recommendFor(views, null, 'en')!.reason).toMatch(/^Meilleure multi-audio/);
  });

  it('hors apprentissage, une langue principale non gérée reste visée en VO', () => {
    localStorage.setItem(LANG_PREFS_KEY, JSON.stringify({ audio: 'ja', learn: false }));
    const views = toSourceViews([mk({ languages: ['original'] })]);
    expect(recommendFor(views, null, 'ja')!.reason).toMatch(/^Meilleure VO/);
  });
});
