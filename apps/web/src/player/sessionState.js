/* État partagé de la session de lecture (session courante, interface, moteurs) et petits utilitaires sans dépendance cyclique. */
import { isKidProfile, isServerMode } from '../data/auth';
import { getLangPrefs, resolveLangPrefs } from '../data/langPrefs';
import { isAnime } from '../data/anime';
import { addonNextEpisode } from './addonRequest';
import { audioLangsFor } from '../sources/load';
import { state as appState } from '../ui/state.js';
import { originSummary } from '../sources/info';
import { browserCaps } from './caps';
import { partLabel } from '../data/episodeParts';
import { MiniState } from './mini';
import { getMemory } from './memory';
import { nextEpisode } from './progress';
import { langFromTitle, normalizeLang } from './tracks';

export const S = {
  ui: null,
  /** Bulle des messages entrants (haut gauche), branchée au social : active pendant la lecture. */
  bubble: null,
  thumbs: null,
  /** Aperçu mpv : images ffmpeg de lastAddon (une par 30 s) ; `addonThumbs` = capacité annoncée par le serveur. */
  feed: null,
  /** Aperçu par plages (src/thumbs) : lecture chez l'hébergeur + WebCodecs, pour les liens débridés distants. */
  rangeFeed: null,
  html: null,
  mpv: null,
  nativeEng: null,
  P: null, // session courante (null : lecteur fermé)
  shell: null, // transport de la coque Windows (null dans un navigateur)
  shellFullscreen: false,
  shellPip: false, // image dans l'image de la coque (petite fenêtre au premier plan)
  nativeMini: false, // vignette flottante du lecteur natif Android affichée (la page web est alors libre)
  lastMiniRect: null, // rectangle de l'image du mini-lecteur (px de la fenêtre), pour mpv
};


export const AUTOPIP_KEY = 'laststream.player.autopip';
export const THUMBS_KEY = 'laststream.player.thumbs';
export const MAX_ATTEMPTS = 6;
export const AUTOSYNC_TARGET = 90;
export const AUTOSYNC_MIN = 25;

export const storeGet = (k) => { try { return globalThis.localStorage.getItem(k); } catch (_) { return null; } };
export const storeSet = (k, v) => { try { globalThis.localStorage.setItem(k, v); } catch (_) { /* ignoré */ } };
export const getCaps = browserCaps;
export const miniState = new MiniState({
  getItem: (k) => storeGet(k),
  setItem: (k, v) => storeSet(k, v),
});

/** Le titre est-il un anime ? Fiche complète (TMDB) d'abord, sinon l'élément de catalogue d'où la lecture est lancée. */
function isAnimeTitle(p) {
  const m = p.model;
  const it = appState.byKey.get(p.req.key);
  return isAnime(m && { genreIds: m.genreIds, originalLanguage: m.origLangCode, originCountry: m.originCountry }) || isAnime(it);
}

/** Réglages de langue d'un titre : section Anime pour un anime (si activée), réglages généraux sinon. */
export const langPrefsOf = (p) => resolveLangPrefs(getLangPrefs(), !!p && isAnimeTitle(p));
export const activeLangPrefs = () => langPrefsOf(S.P);

/** Langues audio à essayer : choix mémorisé pour ce titre, puis langue préférée des réglages. */
export function audioPreference() {
  const mem = S.P ? getMemory(S.P.req.key) : {};
  return audioLangsFor(activeLangPrefs(), mem.audio, S.P ? originalLangOf(S.P) : '');
}

/** Langue d'origine du titre (code à deux lettres), '' si inconnue. */
export function originalLangOf(p) {
  const origName = p.model && p.model.origLang ? String(p.model.origLang) : '';
  return origName ? langFromTitle(origName) || normalizeLang(origName) : '';
}

const seLabel = (r) => (r.season != null ? 'S' + r.season + ':É' + r.episode : '');

/** Titre de la barre haute : « Série » puis « S2:É5 « Titre » ». */
export function headingFor(p) {
  if (p.req.season == null) return [p.meta.title || p.req.name || '', ''];
  const eps = p.episodes.get(p.cur.season);
  const ep = eps && eps.find((e) => e.episode === p.cur.episode);
  // Émission en plusieurs parties : titre de l'épisode sans son « (1) », puis « Partie 1/2 ».
  const name = ep && ep.part ? ep.part.title : ep && ep.name;
  return [p.meta.title || p.req.name || '', seLabel(p.cur) + (name ? ' « ' + name + ' »' : '') + (ep && ep.part ? ' · ' + partLabel(ep.part) : '')];
}

export const sourceLine = (v) => [v.quality, v.langs.map((l) => l.label).join('/'), v.provider, originSummary(v.origins, 1)].filter(Boolean).join(' · ');

export const nextRef = () => (S.P && S.P.addon ? addonNextEpisode(S.P.addon.videos, S.P.cur) : S.P && S.P.req.type === 'tv' && S.P.cur.season != null ? nextEpisode(S.P.seasons, { season: S.P.cur.season, episode: S.P.cur.episode }) : null);

/** Bouton et panneau Épisodes : séries TMDB seulement. Un titre d'addon n'a pas de saisons TMDB ; son épisode suivant reste donné par `nextRef`. */
export const hasEpisodesPanel = (p) => p.req.type === 'tv' && !p.addon;

// ---------- Chargement d'une source ----------

export const abortError = () => new Error('annulé');

/** Clé « titre + épisode » des sources lentes ou en échec (mémorisées 24 h). */
export const badKey = (p) => p.req.key + ':' + (p.cur.season ?? '') + ':' + (p.cur.episode ?? '');
export const describeView = (v) => [v.quality, v.sourceType, v.langs.map((l) => l.label).join('/'), v.provider].filter(Boolean).join(' · ') || 'Source';

// ---------- Notes de la timeline (Social v2) ----------

/** Le social n'existe ni pour un profil enfant ni hors mode serveur. */
export const notesAllowed = () => isServerMode() && !isKidProfile();
