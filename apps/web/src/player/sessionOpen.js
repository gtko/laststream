/* Ouverture de la session : création, reprise, données annexes (segments, saisons, fillers, épisodes) et écran de pause. */
import { isConfigured } from '../data/config';
import { api, skipSegments, tmdb } from '../data/lt';
import { resumePosition } from '../data/watchWith';
import { DEMO_BLOCKED_MSG, isDemo } from '../data/demo';
import { getVideoLang } from '../data/prefs';
import { resolveImdbId } from '../data/imdbResolve';
import { userStore } from '../data/userStore';
import { addonProgressKey, addonOf, addonResumeSource } from './addonRequest';
import { getAddonProgress } from '../data/addonUserStore';
import { IMG } from '../ui/constants.js';
import { state as appState } from '../ui/state.js';
import { applyFillers, isAired, isPlayable, localDay, markParts, nextPart, normalizeCanonical } from './episodes';
import { TrackApplier } from './trackApply';
import { resumeDecision } from './progress';
import { normalizeSkip } from './skip';
import { readSubStyle } from './subs';
import { parseProbe } from './tracks';
import { nextPhase } from './phase';
import { partyBridge } from '../party/bridge';
import { setPresenceMedia } from './presenceV2';
import { markAllowed } from './sessionActions.js';
import { teardown } from './sessionClose.js';
import { syncNative } from './sessionNative.js';
import { playView } from './sessionPlay.js';
import { presenceMediaOf, startNotes, startSocialPlayback } from './sessionSocial.js';
import { S, hasEpisodesPanel, headingFor, nextRef, notesAllowed } from './sessionState.js';
import { memoryWatch, stopTicks, syncTicks } from './sessionTick.js';
import { ensureUI, resetMini } from './sessionUi.js';
import * as playerState from './playerState';


// ---------- Ouverture ----------

/** Crée la session et ouvre le lecteur tout de suite, sans source : l'écran de chargement prend le relais. */
export async function initSession(request, views, view, opts = {}) {
  if (isDemo()) throw new Error(DEMO_BLOCKED_MSG); // mode démo : jamais de session de lecture
  ensureUI();
  S.ui.closeMark(false);
  resetMini();
  if (S.P) await teardown(true);
  const token = Symbol('session');
  S.P = {
    token, req: request, views, ranked: [...views], cur: { season: request.season, episode: request.episode },
    view, tried: new Set(), attempts: 0, engine: S.html, choice: null, probe: null, probeTracks: parseProbe(null), mediaUrl: '',
    segments: [], nextDismissed: false, lastSave: 0, watchedMarked: false, finished: false,
    subs: {
      external: [], loadedFor: null, loading: false, loadSeq: 0, selectedId: null, secondaryId: null, cues2: [], native2: false, shift2: 0, swapped: false, cues: [], offset: 0, rate: 1, rateId: 'none', shift: 0, rateHint: '',
      style: readSubStyle(), native: false, nativeCues: [], styleOpen: false, sync: { state: 'idle', message: '' }, syncKey: '',
    },
    defaultsDone: false, applier: new TrackApplier(), autoToast: false, autoAppliedAt: 0, seasons: [], episodes: new Map(), opener: opts.opener || document.activeElement, failing: false,
    notice: opts.notice || '', forceHls: false, startedAt: 0, resumeTimer: null, imdb: addonOf(request) ? '' : request.imdb || '', addon: addonOf(request), epQuery: '', epSearchOpen: false, canonical: false, pickMine: false,
    aspect: 'contain', local: null, localFailed: false,
    skipPoll: { analyzing: false, polls: 0, lastAt: 0 }, analyzed: false,
  };
  const meta = appState.byKey.get(request.key) || {};
  const model = appState.model && appState.model.key === request.key ? appState.model : null;
  S.P.model = model;
  S.P.meta = {
    poster: meta.posterPath || (model && model.posterPath) || '', backdrop: meta.backdropPath || (model && model.backdropPath) || '', title: request.name || meta.name || '',
    logo: (model && model.logo) || '', overview: (model && model.overview) || meta.overview || '',
  };
  startNotes(S.P);
  // Présence (titre regardé) et bulle des messages : ni l'une ni l'autre pour un profil enfant ou hors mode serveur.
  const social = notesAllowed() && !S.P.addon; // titre d'addon : ni présence, ni bulles, ni salon (ils exigent un id TMDB)
  setPresenceMedia(social ? presenceMediaOf(S.P) : null);
  if (social && S.bubble) S.bubble.start();
  startSocialPlayback(S.P, social);
  document.body.classList.add('modal-open', 'lp-open');
  S.P.phase = nextPhase('ready', 'open');
  S.ui.setPhase(S.P.phase);
  S.ui.root.classList.toggle('is-searching', !view);
  S.ui.root.classList.remove('is-mpv', 'is-video');
  S.ui.setMiniAvailable(true);
  S.ui.video.hidden = false;
  S.ui.video.style.objectFit = 'contain';
  S.ui.setHeading(...headingFor(S.P));
  S.ui.setSeries(hasEpisodesPanel(S.P), false);
  S.ui.setError(null);
  S.ui.setResume(null);
  S.ui.setSkip(null);
  S.ui.setNextCard(null);
  S.ui.setEndRow(false);
  S.ui.setCue('', S.P.subs.style);
  S.ui.show();
  playerState.set({ open: true, mini: false }); // après show() : le fondu d'ouverture retarde lp-covered
  S.ui.focusFirst();
  S.ui.setPartyAvailable(partyBridge.available() && !S.P.addon);
  stopTicks();
  memoryWatch.reset();
  syncTicks(); // boucles d'interface (250 ms) et lente (1 s), arrêtées en pause ou onglet caché
  loadSideData(token);
  updatePauseScreen();
  if (request.type === 'tv') ensureEpisodes(request.season);
  return S.P;
}

/** Données du chargeur : logo, fond, épisode, étapes (sources trouvées → choix → lien) et ligne de source. */
export function loaderExtra(step, over = {}) {
  const p = S.P;
  const found = p.views.length;
  return {
    logo: p.meta.logo, backdrop: p.meta.backdrop ? IMG('w1280', p.meta.backdrop) : '', episode: headingFor(p)[1], cancel: true,
    steps: [found ? found + ' source' + (found > 1 ? 's' : '') + ' trouvée' + (found > 1 ? 's' : '') : 'Recherche des sources', 'Choix de la meilleure source', 'Préparation du lien'],
    step, ...over,
  };
}

/** Position de départ demandée : un nombre, ou le relevé d'un ami estimé à l'instant présent (« Regarder avec lui »). */
function seekPositionOf(start) {
  if (typeof start === 'number') return start;
  return start && typeof start === 'object' ? resumePosition(start, Date.now()) : null;
}

/** Progression enregistrée du titre en cours : stockage des addons (`addonUserStore`) pour un titre d'addon, `userStore` sinon. */
function savedProgressOf(p) {
  if (p.addon) return addonResumeSource(getAddonProgress(addonProgressKey(p.addon)), p.cur);
  return userStore.getProgress(p.req.key, p.req.season ?? undefined, p.req.episode ?? undefined);
}

/** Poursuit la session avec la source choisie : reprise éventuelle puis lecture. */
export function continueWith(view, opts = {}) {
  const p = S.P;
  p.view = view;
  p.notice = opts.notice || p.notice;
  S.ui.root.classList.remove('is-searching');
  const saved = savedProgressOf(p);
  const rd = resumeDecision(saved);
  const mode = opts.resume || 'ask';
  const at = seekPositionOf(typeof opts.startAt === 'number' ? opts.startAt : p.seekStart);
  p.seekStart = null; // appliquée une seule fois : une reprise ultérieure suit la progression, pas l'ancienne demande
  if (typeof at === 'number') return playView(view, at);
  if (rd.prompt && mode === 'ask') {
    S.ui.setLoading(null);
    S.ui.setResume(rd.position);
    p.resumeTimer = setTimeout(() => chooseResume(true), 12_000);
    return undefined;
  }
  return playView(view, rd.prompt && mode === 'auto' ? rd.position : 0);
}

export function chooseResume(resume) {
  if (!S.P || !S.P.resumeTimer) return;
  clearTimeout(S.P.resumeTimer);
  S.P.resumeTimer = null;
  const saved = savedProgressOf(S.P);
  const rd = resumeDecision(saved);
  S.ui.setResume(null);
  playView(S.P.view, resume ? rd.position : 0);
}

/** Données annexes chargées en parallèle : segments de saut, saisons. */
function loadSideData(token) {
  const p = S.P;
  const alive = () => S.P && S.P.token === token;
  // Titre d'addon : ni IMDb ni segments de saut (lastAddon les indexe par IMDb) ; les épisodes viennent de la fiche de l'addon.
  if (p.addon) { S.ui.setSeries(hasEpisodesPanel(p), !!nextRef()); return; }
  (async () => {
    try {
      if (!p.imdb) p.imdb = (await resolveImdbId(p.req.type, p.req.id)).imdb || '';
      if (alive()) S.ui.setMarkAvailable(markAllowed(p));
      if (p.imdb && isConfigured()) {
        const r = await skipSegments(p.req.type === 'tv' ? 'series' : 'movie', p.imdb, p.req.type === 'tv' ? p.req.season ?? 1 : 0, p.req.type === 'tv' ? p.req.episode ?? 1 : 0);
        if (alive()) {
          p.segments = normalizeSkip(r);
          syncNative();
          p.skipPoll = { analyzing: !!r && r.analyzing === true, polls: 0, lastAt: Date.now() };
        }
      }
    } catch (_) { /* pas de segments : aucun bouton de saut */ }
  })();
  if (p.req.type === 'tv') loadSeasons().then(() => { if (alive()) { S.ui.setSeries(true, !!nextRef()); syncNative(); } });
}

/** Saisons : réponse canonique de lastAddon (TVDB / groupes TMDB), sinon saisons TMDB. */
async function loadSeasons() {
  const p = S.P;
  if (!p || p.addon || p.seasons.length) return;
  try {
    const c = normalizeCanonical(await api('series/' + p.req.id + '/episodes', { language: getVideoLang().tag }));
    if (c && S.P === p) { p.seasons = c.seasons; p.episodes = c.episodes; p.canonical = true; loadFillers(p); return; }
  } catch (_) { /* repli TMDB */ }
  const m = p.model;
  let list = m && Array.isArray(m.seasons) ? m.seasons : null;
  if (!list) {
    try { const d = await tmdb('tv/' + p.req.id); list = d && d.seasons; } catch (_) { list = null; }
  }
  if (S.P !== p) return;
  p.seasons = (list || []).map((s) => ({ season: s.season_number, count: s.episode_count || 0 })).filter((s) => s.season > 0 && s.count > 0);
}

/** Épisodes filler et récap d'un anime (lastAddon, d'après MyAnimeList), en arrière-plan : badge et saut optionnel. */
function loadFillers(p) {
  api('series/' + p.req.id + '/fillers', { language: getVideoLang().tag })
    .then((r) => { if (S.P === p) { applyFillers(p.episodes, r); S.ui.refreshPanel(); } })
    .catch(() => { /* pas de données filler : aucun badge */ });
}

export async function ensureEpisodes(season, reveal) {
  const p = S.P;
  if (!p || p.addon || p.req.type !== 'tv') return; // titre d'addon : pas de TMDB, pas de liste d'épisodes
  // « Chargement… » dès l'ouverture, y compris pendant la liste canonique des saisons.
  if (!p.seasons.length) { p.episodesLoading = true; p.episodesError = false; S.ui.refreshPanel(); }
  await loadSeasons();
  if (S.P !== p) return;
  const s = season ?? p.cur.season ?? 1;
  p.panelSeason = s;
  if (!p.episodes.has(s)) {
    p.episodesLoading = true;
    p.episodesError = false;
    S.ui.refreshPanel();
    try {
      const d = await tmdb('tv/' + p.req.id + '/season/' + s);
      if (S.P !== p) return;
      const today = localDay(new Date());
      p.episodes.set(s, markParts((d.episodes || []).map((e) => ({
        episode: e.episode_number, name: e.name || '', runtime: e.runtime || null, overview: e.overview || '', still: IMG('w300', e.still_path),
        airDate: e.air_date || '', aired: isAired(e.air_date || '', today), playable: isPlayable(e.air_date || '', today),
      }))));
    } catch (_) { if (S.P === p) p.episodesError = true; } // pas mis en cache : rouvrir le panneau réessaie
    if (S.P === p) p.episodesLoading = false;
  } else p.episodesLoading = false;
  if (S.P !== p) return;
  S.ui.setHeading(...headingFor(p));
  updatePauseScreen();
  S.ui.refreshPanel();
  syncNative();
  if (reveal) S.ui.revealEpisode(s === p.cur.season ? p.cur.episode : 0);
}

/** Écran de pause : « Vous regardez… » avec le résumé de l'épisode (ou du film). */
function updatePauseScreen() {
  const p = S.P;
  if (!p) return;
  const eps = p.episodes.get(p.cur.season);
  const ep = eps && eps.find((e) => e.episode === p.cur.episode);
  const [title, sub] = headingFor(p);
  S.ui.setPauseScreen({ title, logo: p.meta.logo, episode: sub, synopsis: (ep && ep.overview) || p.meta.overview || '', backdrop: p.meta.backdrop ? IMG('w1280', p.meta.backdrop) : '' });
}

/** `nx` est la partie suivante de l'émission en cours (« Partie 1/2 » → « Partie 2/2 »). */
export function continuesPart(p, nx) {
  const next = nx.season === p.cur.season ? nextPart(p.episodes.get(nx.season), p.cur.episode) : null;
  return !!next && next.episode === nx.episode;
}
