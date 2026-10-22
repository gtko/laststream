/*
 * Préférences de langue audio / sous-titres du profil, appliquées au démarrage de chaque lecture.
 * Stockées dans le navigateur (une clé JSON de moins de 500 octets) et synchronisées avec le compte comme les autres
 * réglages du profil : `snapshotPrefs` les place sous la clé `langPrefs`, `applyPrefs` les relit.
 * La source de vérité du mode des sous-titres (Auto / Toujours / Jamais du panneau du lecteur) est `subsOn` ici.
 */
import { normalizeLang } from '../player/tracks';
import { readSubStyle } from '../player/subs';
import { getVideoLang } from './prefs';

export const LANG_PREFS_KEY = 'laststream.langprefs';

/** Langue audio « version originale » (langue d'origine du titre) et « aucune ». */
export const LANG_VO = 'vo';
export const LANG_NONE = 'none';
/** Sous-titres dans la langue audio principale. */
export const LANG_MAIN = 'main';

/** Réglages propres aux animes (voir `isAnime`) : remplacent les réglages généraux pour ces titres seulement. */
export interface AnimePrefs {
  /** Interrupteur : désactivé, les animes suivent les réglages généraux. */
  on: boolean;
  /** Audio visé : `fr` (VF), `ja` (VO japonaise), `vo` (langue d'origine du titre), `en`. */
  audio: string;
  /** Sous-titres : `none`, `fr`, `en` ou `forced` (forcés de ma langue seulement). */
  subs: string;
  /** Sous-titres seulement si l'audio n'est pas dans ma langue (langue audio principale générale). */
  ifForeign: boolean;
}

export const ANIME_AUDIO_CHOICES: ReadonlyArray<readonly [string, string]> = [['fr', 'Français (VF)'], ['ja', 'Japonais (VO)'], [LANG_VO, 'Langue d’origine'], ['en', 'Anglais']];
export const ANIME_SUBS_CHOICES: ReadonlyArray<readonly [string, string]> = [['none', 'Aucun'], ['fr', 'Français'], ['en', 'Anglais'], ['forced', 'Forcés seulement']];
const DEFAULT_ANIME_PREFS: AnimePrefs = { on: false, audio: 'ja', subs: 'fr', ifForeign: true };

export interface LangPrefs {
  /** Langue audio principale (code à deux lettres). */
  audio: string;
  /** Langue audio secondaire : code, `vo` (version originale) ou `none`. */
  audio2: string;
  /** Sous-titres quand l'audio n'est pas dans la langue principale. */
  subsOn: boolean;
  /** Langue des sous-titres : `main` (= langue principale) ou un code. */
  subs: string;
  /** Mode apprentissage : audio et sous-titres dans la langue apprise, doublés de la langue principale. */
  learn: boolean;
  learnLang: string;
  /** Réglages des animes. */
  anime: AnimePrefs;
}

export const DEFAULT_LANG_PREFS: LangPrefs = { audio: 'fr', audio2: LANG_VO, subsOn: true, subs: LANG_MAIN, learn: false, learnLang: 'en', anime: DEFAULT_ANIME_PREFS };

/** Langues proposées (code, libellé), dans l'ordre d'affichage. */
export const LANG_CHOICES: ReadonlyArray<readonly [string, string]> = [
  ['fr', 'Français'], ['en', 'Anglais'], ['ja', 'Japonais'], ['es', 'Espagnol'], ['de', 'Allemand'], ['it', 'Italien'],
  ['ko', 'Coréen'], ['pt', 'Portugais'], ['zh', 'Chinois'], ['ru', 'Russe'], ['ar', 'Arabe'], ['nl', 'Néerlandais'], ['pl', 'Polonais'], ['tr', 'Turc'], ['sv', 'Suédois'],
];
const KNOWN = new Set(LANG_CHOICES.map(([c]) => c));

const code = (raw: unknown, fallback: string, extra: readonly string[] = []): string => {
  if (typeof raw !== 'string') return fallback;
  const t = raw.trim().toLowerCase();
  if (extra.includes(t)) return t;
  const c = normalizeLang(t);
  return KNOWN.has(c) ? c : fallback;
};

const oneOf = (raw: unknown, choices: ReadonlyArray<readonly [string, string]>, fallback: string): string => {
  const t = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return choices.some(([c]) => c === t) ? t : fallback;
};

function normalizeAnime(x: unknown, base: AnimePrefs): AnimePrefs {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  return {
    on: typeof o.on === 'boolean' ? o.on : base.on,
    audio: oneOf(o.audio, ANIME_AUDIO_CHOICES, base.audio),
    subs: oneOf(o.subs, ANIME_SUBS_CHOICES, base.subs),
    ifForeign: typeof o.ifForeign === 'boolean' ? o.ifForeign : base.ifForeign,
  };
}

/** Réglages valides à partir de n'importe quelle valeur (champs inconnus ignorés, défauts pour le reste). */
export function normalizeLangPrefs(x: unknown, base: LangPrefs = DEFAULT_LANG_PREFS): LangPrefs {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  return {
    audio: code(o.audio, base.audio, [LANG_VO]),
    audio2: code(o.audio2, base.audio2, [LANG_VO, LANG_NONE]),
    subsOn: typeof o.subsOn === 'boolean' ? o.subsOn : base.subsOn,
    subs: code(o.subs, base.subs, [LANG_MAIN]),
    learn: typeof o.learn === 'boolean' ? o.learn : base.learn,
    learnLang: code(o.learnLang, base.learnLang),
    anime: normalizeAnime(o.anime, base.anime),
  };
}

/** Valeurs de départ pour qui n'a encore rien enregistré : l'ancien réglage de langue et le mode des sous-titres du lecteur. */
export function legacyLangPrefs(): LangPrefs {
  let audio = 'fr';
  try { audio = getVideoLang().lang; } catch { /* langue par défaut */ }
  let subsOn = true;
  try { subsOn = readSubStyle().mode !== 'off'; } catch { /* activés */ }
  return normalizeLangPrefs({ audio, subsOn });
}

function readRaw(): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(LANG_PREFS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function hasStoredLangPrefs(): boolean {
  return readRaw() !== null;
}

export function getLangPrefs(): LangPrefs {
  const stored = readRaw();
  return stored ? normalizeLangPrefs(stored, legacyLangPrefs()) : legacyLangPrefs();
}

/** Enregistre (fusionne) des réglages et renvoie l'état résultant. */
export function setLangPrefs(patch: Partial<LangPrefs>): LangPrefs {
  const next = normalizeLangPrefs({ ...getLangPrefs(), ...patch });
  try { globalThis.localStorage?.setItem(LANG_PREFS_KEY, JSON.stringify(next)); } catch { /* valable pour la session seulement */ }
  return next;
}


/** Langue des sous-titres que ces réglages cherchent en premier (sert au classement des sous-titres externes). */
export function wantedSubLang(lp: LangPrefs): string {
  if (lp.learn && lp.learnLang !== lp.audio) return lp.learnLang;
  return lp.subs === LANG_MAIN ? lp.audio : lp.subs;
}

/** Enregistre (fusionne) les réglages des animes seulement. */
export function setAnimePrefs(patch: Partial<AnimePrefs>): LangPrefs {
  return setLangPrefs({ anime: { ...getLangPrefs().anime, ...patch } });
}

/**
 * Réglages effectifs pour un titre : pour un anime dont les réglages sont activés, l'audio, les sous-titres et la langue
 * de l'utilisateur viennent de la section Anime (mode apprentissage ignoré) ; sinon les réglages généraux, tels quels.
 * Les champs ajoutés sont lus par `pickTracks` ; le reste (classement des sources, sous-titres externes) lit les champs de base.
 */
export interface EffectiveLangPrefs extends LangPrefs {
  /** Anime : ma langue (audio principal général), distincte de l'audio visé. */
  native?: string;
  /** Anime : sous-titres même quand l'audio est dans ma langue. */
  subsAlways?: boolean;
  /** Anime : sous-titres forcés de ma langue seulement. */
  forcedOnly?: boolean;
  /** Anime : aucun sous-titre. */
  noSubs?: boolean;
}

export function resolveLangPrefs(lp: LangPrefs, anime: boolean): EffectiveLangPrefs {
  const a = lp.anime;
  if (!anime || !a.on) return lp;
  const native = lp.audio === LANG_VO ? 'fr' : lp.audio;
  const subs = a.subs === 'fr' || a.subs === 'en' ? a.subs : native;
  return {
    ...lp,
    audio: a.audio,
    audio2: a.audio === lp.audio ? lp.audio2 : lp.audio,
    subsOn: a.subs !== 'none',
    subs,
    learn: false,
    native,
    subsAlways: !a.ifForeign,
    forcedOnly: a.subs === 'forced',
    noSubs: a.subs === 'none',
  };
}
