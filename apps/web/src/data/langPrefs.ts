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
}

export const DEFAULT_LANG_PREFS: LangPrefs = { audio: 'fr', audio2: LANG_VO, subsOn: true, subs: LANG_MAIN, learn: false, learnLang: 'en' };

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

/** Libellé d'un code de langue des réglages. */
function langPrefLabel(c: string): string {
  if (c === LANG_VO) return 'Version originale';
  if (c === LANG_NONE) return 'Aucune';
  return LANG_CHOICES.find(([k]) => k === c)?.[1] ?? c.toUpperCase();
}

/** Langue des sous-titres que ces réglages cherchent en premier (sert au classement des sous-titres externes). */
export function wantedSubLang(lp: LangPrefs): string {
  if (lp.learn && lp.learnLang !== lp.audio) return lp.learnLang;
  return lp.subs === LANG_MAIN ? lp.audio : lp.subs;
}
