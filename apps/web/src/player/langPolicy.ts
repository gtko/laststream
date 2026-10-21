import { LANG_MAIN, LANG_NONE, LANG_VO, type LangPrefs } from '../data/langPrefs';
import { langName, normalizeLang, trackLang, type AudioTrack, type SubtitleTrack } from './tracks';

/*
 * Politique de langue des pistes : choisit l'audio et les sous-titres (jusqu'à deux) au démarrage d'une lecture, d'après
 * les préférences du profil. Fonctions pures, testées, partagées par les trois moteurs (HTML5 / HLS, mpv, libVLC Android).
 */

const strip = (t: string | undefined | null): string => (t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Code de langue (fr, en…) d'une valeur de piste : balise, VF / VFF / VFQ / VOSTFR, nom (« French », « Japonais »)… ; vide si inconnu (« und »). */
export function langCode(raw: string | undefined | null, title?: string | null): string {
  return trackLang(raw, title);
}

const isForced = (t: { forced?: boolean; title?: string; label?: string }): boolean => t.forced === true || /\bforc|\bforced\b|\bforces\b/.test(strip(t.title) + ' ' + strip(t.label));
const isSdh = (t: { title?: string; label?: string }): boolean => /\b(sdh|cc|hearing|hoh|malentendant|sourds?)\b/.test(strip(t.title) + ' ' + strip(t.label));
const isFullTitle = (t: { title?: string }): boolean => /\b(full|complet|complets|dialog|dialogue|dialogues)\b/.test(strip(t.title));
const isCommentary = (t: { title?: string }): boolean => /commentar|commentaire|director/.test(strip(t.title));
const isDescriptive = (t: { title?: string }): boolean => /audio.?description|audiodescription|descriptive|\bad\b|malvoyant/.test(strip(t.title));
const looksOriginal = (t: { title?: string }): boolean => /\b(vo|original|version originale|ov)\b/.test(strip(t.title));

export interface TrackContext {
  /** Langue d'origine du titre (code), si connue : sert à la « version originale ». */
  originalLang?: string;
  /** Langue supposée d'une piste audio sans balise (ex. `fr` quand la source annonce du français). */
  unknownAudioLang?: string;
  /** Mode « Toujours » du panneau du lecteur : sous-titres même quand l'audio est dans la langue principale. */
  alwaysSubs?: boolean;
  /** Langue audio mémorisée pour ce titre (choix manuel antérieur) : prime sur les préférences si la piste existe. */
  rememberedAudio?: string;
  /** Sous-titres mémorisés pour ce titre : `off` ou code de langue ; un seul sous-titre, sans second. */
  rememberedSub?: string;
  /** Une piste peut-elle servir de second sous-titre dans ce moteur ? (défaut : oui). */
  canSecondary?: (t: SubtitleTrack) => boolean;
}

export interface TrackPick {
  audioId: string | null;
  subId: string | null;
  secondarySubId: string | null;
  /** Langue de la piste audio choisie ('' : inconnue ou aucune piste). */
  audioLang: string;
  subLang: string;
  secondaryLang: string;
  /** Mode apprentissage sans piste audio dans la langue apprise : repli sur une autre piste. */
  learnAudioMissing: boolean;
  /** Mode apprentissage sans sous-titre dans la langue apprise : la langue principale seule. */
  learnSubMissing: boolean;
  /** Une piste de la langue principale aurait été le second sous-titre, mais le moteur (`canSecondary`) l'a refusée. */
  secondaryBlocked: boolean;
}

/** Résout un code de préférence (`vo`, `fr`…) en code de langue de piste ; `''` pour « version originale » inconnue. */
function wantedLang(pref: string, ctx: TrackContext): string {
  if (pref === LANG_VO) return normalizeLang(ctx.originalLang);
  return normalizeLang(pref);
}

/** Langue d'une piste telle que le moteur l'annonce, normalisée (balise à 2 ou 3 lettres, sinon indice du titre). */
const tl = (t: { lang?: string; title?: string }): string => trackLang(t.lang, t.title);

const audioQuality = (t: AudioTrack): number => (isCommentary(t) || isDescriptive(t) ? -1000 : 0) + (t.channels || 0);

/** Meilleure piste audio d'une liste (hors commentaire / audiodescription si possible, puis plus de canaux, puis la première). */
function bestAudio(list: readonly AudioTrack[]): AudioTrack | null {
  let best: AudioTrack | null = null;
  for (const t of list) if (!best || audioQuality(t) > audioQuality(best)) best = t;
  return best;
}

/** Piste audio d'une préférence : langue précise, ou « version originale » (langue d'origine, sinon titre « VO », sinon première piste hors langue principale). */
function audioFor(pref: string, tracks: readonly AudioTrack[], prefs: LangPrefs, ctx: TrackContext): AudioTrack | null {
  if (pref === LANG_NONE || !pref) return null;
  const lang = (t: AudioTrack): string => tl(t) || ctx.unknownAudioLang || '';
  if (pref !== LANG_VO) return bestAudio(tracks.filter((t) => lang(t) === normalizeLang(pref)));
  const orig = wantedLang(LANG_VO, ctx);
  if (orig) {
    const m = bestAudio(tracks.filter((t) => lang(t) === orig));
    if (m) return m;
  }
  const byTitle = bestAudio(tracks.filter((t) => looksOriginal(t)));
  if (byTitle) return byTitle;
  // Langue d'origine inconnue : la première piste du fichier qui n'est pas dans la langue principale (la VO y est presque toujours en tête).
  const main = normalizeLang(prefs.audio);
  const other = tracks.filter((t) => lang(t) !== main && !isCommentary(t) && !isDescriptive(t));
  return other[0] ?? null;
}

/** Rang d'une piste de sous-titres pour une langue : plus petit = meilleur. 99 : à écarter. */
function subRank(t: SubtitleTrack, wantForced: boolean): number {
  if (!t.renderable) return 99;
  const forced = isForced(t);
  if (wantForced) return forced ? (isSdh(t) ? 1 : 0) : 99;
  if (forced && !isFullTitle(t)) return 90; // dernier recours : ne traduit que les passages étrangers
  const sdh = isSdh(t);
  const origin = t.origin === 'external' ? 1 : 0;
  // Complets non SDH (internes puis externes), puis SDH ; un titre « Full » passe devant.
  return (sdh ? 20 : 0) + origin * 10 + (isFullTitle(t) ? 0 : 1);
}

function bestSub(tracks: readonly SubtitleTrack[], lang: string, wantForced: boolean, exclude: ReadonlySet<string>, ok?: (t: SubtitleTrack) => boolean): SubtitleTrack | null {
  const code = normalizeLang(lang);
  if (!code) return null;
  let best: SubtitleTrack | null = null;
  let bestRank = 99;
  for (const t of tracks) {
    if (exclude.has(t.id) || tl(t) !== code || (ok && !ok(t))) continue;
    const r = subRank(t, wantForced);
    if (r < bestRank) { best = t; bestRank = r; }
  }
  return best;
}

/** Langue principale (code), `fr` à défaut. */
const mainOf = (prefs: LangPrefs): string => normalizeLang(prefs.audio) || 'fr';

/** Mode apprentissage actif : une langue apprise, distincte de la langue principale. */
const learnOn = (prefs: LangPrefs): boolean => {
  const learned = normalizeLang(prefs.learnLang);
  return prefs.learn && !!learned && learned !== mainOf(prefs);
};

/**
 * Second sous-titre du mode apprentissage : piste de la langue principale, distincte du premier. `blocked` : une telle piste
 * existe mais le moteur (`canSecondary`) ne peut pas l'afficher en même temps.
 */
function secondaryOf(subTracks: readonly SubtitleTrack[], prefs: LangPrefs, first: SubtitleTrack | null, canSecondary?: (t: SubtitleTrack) => boolean): { track: SubtitleTrack | null; blocked: boolean } {
  const main = mainOf(prefs);
  if (!first || !learnOn(prefs) || tl(first) === main) return { track: null, blocked: false };
  const exclude = new Set([first.id]);
  const track = bestSub(subTracks, main, false, exclude, canSecondary);
  return { track, blocked: !track && bestSub(subTracks, main, false, exclude) !== null };
}

/**
 * Choisit audio, sous-titre et second sous-titre.
 * - Audio : langue principale si présente (sinon secondaire — version originale par défaut —, sinon la meilleure disponible).
 * - Audio dans la langue principale : pas de sous-titres, sauf les pistes « forcés » de cette langue.
 * - Sinon, si les sous-titres sont activés : la langue choisie (pistes internes d'abord, puis externes déjà chargées ;
 *   « Full » avant « Forced », SDH seulement s'il n'y a rien d'autre).
 * - Mode apprentissage : audio dans la langue apprise (sinon secondaire, sinon principale), sous-titre appris + sous-titre
 *   dans la langue principale en second. « Jamais » : aucun sous-titre, l'audio reste dans la langue apprise. Un sous-titre
 *   mémorisé (choix manuel) remplace seulement le premier ; le second est recalculé.
 */
export function pickTracks(audioTracks: readonly AudioTrack[], subTracks: readonly SubtitleTrack[], prefs: LangPrefs, ctx: TrackContext = {}): TrackPick {
  const main = mainOf(prefs);
  const learn = learnOn(prefs);
  const learned = normalizeLang(prefs.learnLang);
  const order = learn ? [prefs.learnLang, prefs.audio2, prefs.audio] : [prefs.audio, prefs.audio2];
  let audio: AudioTrack | null = ctx.rememberedAudio ? audioFor(ctx.rememberedAudio, audioTracks, prefs, ctx) : null;
  for (const pref of audio ? [] : order) {
    audio = audioFor(pref, audioTracks, prefs, ctx);
    if (audio) break;
  }
  // « Meilleure disponible » : la piste par défaut du fichier (déjà sélectionnée), sinon la meilleure.
  if (!audio && audioTracks.length) audio = audioTracks.find((t) => t.selected && !isCommentary(t) && !isDescriptive(t)) ?? bestAudio(audioTracks);
  const audioLang = audio ? tl(audio) || ctx.unknownAudioLang || '' : '';

  const none = new Set<string>();
  const out: TrackPick = {
    audioId: audio ? audio.id : null, subId: null, secondarySubId: null, audioLang, subLang: '', secondaryLang: '',
    learnAudioMissing: learn && audioFor(prefs.learnLang, audioTracks, prefs, ctx) === null,
    learnSubMissing: learn && bestSub(subTracks, learned, false, none) === null,
    secondaryBlocked: false,
  };
  const take = (t: SubtitleTrack | null, slot: 'sub' | 'secondary'): void => {
    if (!t) return;
    if (slot === 'sub') { out.subId = t.id; out.subLang = tl(t); } else { out.secondarySubId = t.id; out.secondaryLang = tl(t); }
  };
  /** Second sous-titre (mode apprentissage) d'après le premier sous-titre choisi. */
  const takeSecond = (first: SubtitleTrack | null): void => {
    const second = secondaryOf(subTracks, prefs, first, ctx.canSecondary);
    take(second.track, 'secondary');
    out.secondaryBlocked = second.blocked;
  };

  if (ctx.rememberedSub) {
    // Choix manuel : remplace le premier sous-titre ; en apprentissage, le second (langue principale) reste calculé.
    if (ctx.rememberedSub === 'off') return out;
    const first = bestSub(subTracks, ctx.rememberedSub, false, none);
    take(first, 'sub');
    takeSecond(first);
    return out;
  }

  if (learn) {
    if (!prefs.subsOn) return out; // « Jamais » l'emporte : aucun sous-titre, l'audio reste dans la langue apprise
    const first = bestSub(subTracks, learned, false, none);
    if (first) {
      take(first, 'sub');
      takeSecond(first);
    } else {
      take(bestSub(subTracks, main, false, none), 'sub'); // pas de sous-titres appris : le français seul
    }
    return out;
  }

  const subLang = prefs.subs === LANG_MAIN ? main : normalizeLang(prefs.subs) || main;
  if (audioLang && audioLang === main && !ctx.alwaysSubs) {
    // Dans la langue principale : seulement les sous-titres forcés de cette langue.
    take(bestSub(subTracks, main, true, none), 'sub');
    return out;
  }
  if (!prefs.subsOn) return out;
  take(bestSub(subTracks, subLang, false, none), 'sub');
  return out;
}

/** « Sous-titres français activés (audio : japonais) » ; vide si rien n'a été activé. */
export function autoSubsToast(pick: TrackPick): string {
  if (!pick.subLang) return '';
  const audio = pick.audioLang ? audioName(pick.audioLang) : '';
  const both = pick.secondaryLang ? 'Sous-titres ' + subAdj(pick.subLang) + ' et ' + subAdj(pick.secondaryLang) + ' activés' : 'Sous-titres ' + subAdj(pick.subLang) + ' activés';
  return both + (audio ? ' (audio : ' + audio + ')' : '');
}

/** Noms de langue accordés avec « sous-titres » (pluriel) ; à défaut, le nom de la langue en minuscules. */
const ADJ: Record<string, string> = {
  fr: 'français', en: 'anglais', ja: 'japonais', es: 'espagnols', de: 'allemands', it: 'italiens', ko: 'coréens', pt: 'portugais', zh: 'chinois', ru: 'russes', ar: 'arabes', nl: 'néerlandais', pl: 'polonais', tr: 'turcs', sv: 'suédois',
};

/** Nom d'une langue dans un message sur les sous-titres (« japonais », « espagnols »). */
const subAdj = (code: string): string => ADJ[code] ?? langName(code).toLowerCase();

/** Nom d'une langue dans un message sur l'audio, au singulier (« japonais », « espagnol »). */
const audioName = (code: string): string => langName(code).toLowerCase();

/**
 * Second sous-titre à appliquer quand l'utilisateur choisit lui-même le sous-titre principal (`firstId`, `null` : « off »).
 * Mode apprentissage seulement. `null` si rien ne convient : pas de langue principale distincte, ou second refusé par le moteur.
 */
export function secondaryFor(subTracks: readonly SubtitleTrack[], prefs: LangPrefs, firstId: string | null, canSecondary?: (t: SubtitleTrack) => boolean): string | null {
  if (firstId === null) return null;
  const first = subTracks.find((t) => t.id === firstId) ?? null;
  return secondaryOf(subTracks, prefs, first, canSecondary).track?.id ?? null;
}

/** Options du message d'apprentissage : moteur courant, langue audio non modifiable, sous-titres désactivés (« Jamais »). */
interface LearnNoticeOpts {
  /** Moteur de lecture (`native` : libVLC Android, qui n'affiche qu'un sous-titre à la fois). */
  engineKind?: string;
  /** La source ne permet pas de changer la langue audio. */
  audioUnknown?: boolean;
  /** Sous-titres désactivés : aucun message sur les sous-titres. */
  subsOff?: boolean;
}

/** Message unique du mode apprentissage, fragments joints par « · » ; '' s'il n'y a rien à dire. */
export function learnNotice(pick: TrackPick, prefs: LangPrefs, opts: LearnNoticeOpts = {}): string {
  const learned = normalizeLang(prefs.learnLang);
  const parts: string[] = [];
  if (pick.learnAudioMissing) parts.push(`Pas d'audio ${audioName(learned)}` + (pick.audioLang ? ` : audio ${audioName(pick.audioLang)}` : ''));
  if (pick.learnSubMissing && !opts.subsOff) parts.push(`Pas de sous-titres ${subAdj(learned)}` + (pick.subLang ? ` : ${subAdj(pick.subLang)} seuls` : ''));
  if (pick.secondaryBlocked && !opts.subsOff) {
    parts.push(opts.engineKind === 'native' ? `Un seul sous-titre sur ce lecteur : ${subAdj(pick.subLang || learned)} seuls` : 'Second sous-titre indisponible (sous-titres intégrés)');
  }
  if (opts.audioUnknown) parts.push('Langue audio non modifiable avec cette source');
  return parts.join(' · ');
}

/* Messages sur le second sous-titre, affichés par session.js. */
export const SECONDARY_OFF_MSG = 'Second sous-titre retiré';
export const SECONDARY_UNSUPPORTED_MSG = 'Second sous-titre non pris en charge ici';
export const SECONDARY_EMPTY_MSG = 'Second sous-titre vide ou illisible';
export const SECONDARY_LOAD_FAIL_MSG = 'Impossible de charger le second sous-titre';
