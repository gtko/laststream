/* Session de lecture : s'ouvre tout de suite (écran de chargement), cherche et choisit la source à l'intérieur du lecteur,
 * choisit le moteur, suit la progression, saute les génériques, bascule sur une autre copie en cas d'échec, gère pistes
 * audio, sous-titres (calage compris), épisodes. L'interface est dans ui.js et panels.js. */
import { addonUrl, isConfigured } from '../data/config';
import { api, postLt, skipSegments, tmdb } from '../data/lt';
import { getAutoplay, getSkipPref, getVideoLang } from '../data/prefs';
import { imdbIdOf, measureBandwidthKbps, stremioId } from '../data/sources';
import { userStore } from '../data/userStore';
import { loadSources, preferredLang, recommendFor } from '../sources/load';
import { openSourcePicker } from '../sources/picker.js';
import { IMG } from '../ui/constants.js';
import { showRatePrompt } from '../ui/rate.js';
import { state as appState } from '../ui/state.js';
import { createLevelProbe, levelProbeSupported } from './audiolevel.js';
import { browserCaps } from './caps';
import { chooseEngine } from './engine';
import { HtmlEngine, MpvEngine } from './engines.js';
import { filterEpisodes, firstUnseen, normalizeCanonical } from './episodes';
import { fetchExternalSubtitles } from './extsubs';
import { StallWatch, failoverOrder } from './failover';
import { keyToAction, stepVolume } from './keys';
import { fileKey, getMemory, getSubSync, remember, setSubSync } from './memory';
import { formatClock, isWatched, nextEpisode, resumeDecision, shouldSave } from './progress';
import { connectShell } from './shell';
import { activeSkip, autoSkipEnabled, buildSubmission, chapterMarks, movieEndRow, nextEpisodeCard, normalizeSkip } from './skip';
import {
  createTorrent, embeddedSubtitleUrl, fetchOpenSubParams, fetchProbe, hlsMasterUrl, hlsQuery, newSessionId, proxyUrl,
  serverAlive, serverBase, subtitlesVttUrl,
} from './server';
import { activeCue, cueHtml, normalizeSubStyle, parseSubtitles, readSubStyle, writeSubStyle } from './subs';
import { RATE_CHOICES, findSync, rateChoice, suggestRate, syncTrusted } from './subsync';
import { parseProbe, pickDefaultAudio, pickDefaultSubtitle, pickRememberedSubtitle } from './tracks';
import { groupAudioTracks, sectionSubtitleTracks } from './trackgroups';
import { Thumbs } from './thumbview.js';
import { thumbsAllowed } from './thumbs';
import { createPlayerUI } from './ui.js';
import { knownBandwidthKbps } from '../sources/load';

const AUTOPIP_KEY = 'laststream.player.autopip';
const THUMBS_KEY = 'laststream.player.thumbs';
const MAX_ATTEMPTS = 6;
const AUTOSYNC_TARGET = 90;
const AUTOSYNC_MIN = 25;

let ui = null;
let thumbs = null;
let html = null;
let mpv = null;
let P = null; // session courante (null : lecteur fermé)
let tickTimer = null;

const storeGet = (k) => { try { return globalThis.localStorage.getItem(k); } catch (_) { return null; } };
const storeSet = (k, v) => { try { globalThis.localStorage.setItem(k, v); } catch (_) { /* ignoré */ } };
const getCaps = browserCaps;

/** Langues audio à essayer : choix mémorisé pour ce titre, puis langue préférée des réglages. */
function audioPreference() {
  const mem = P ? getMemory(P.req.key) : {};
  return [mem.audio, preferredLang()].filter(Boolean);
}

const seLabel = (r) => (r.season != null ? 'S' + r.season + ':É' + r.episode : '');

/** Titre de la barre haute : « Série » puis « S2:É5 « Titre » ». */
function headingFor(p) {
  if (p.req.season == null) return [p.meta.title || p.req.name || '', ''];
  const eps = p.episodes.get(p.cur.season);
  const ep = eps && eps.find((e) => e.episode === p.cur.episode);
  return [p.meta.title || p.req.name || '', seLabel(p.cur) + (ep && ep.name ? ' « ' + ep.name + ' »' : '')];
}

const sourceLine = (v) => [v.quality, v.langs.map((l) => l.label).join('/'), v.provider || (v.status === 'p2p' ? 'P2P' : '')].filter(Boolean).join(' · ');

// ---------- Création de l'interface (une seule fois) ----------
function ensureUI() {
  if (ui) return;
  ui = createPlayerUI({
    action: onAction,
    seekTo: (t) => seekTo(t),
    setVolume: (v) => { if (P) { P.engine.setMuted(false); P.engine.setVolume(v); rememberVolume(v); } },
    panelData,
    panelOpened: (name) => {
      if (name === 'tracks') ensureExternalSubs();
      if (name === 'episodes') ensureEpisodes(P && P.cur.season, true);
    },
    // Fermer le panneau des sources sans avoir choisi (recherche initiale) annule la lecture : retour à la fiche.
    panelClosed: (name) => { if (name === 'sources' && P && !P.view) closePlayer(); },
    thumb: (t) => { if (thumbs && P && P.view) thumbs.request(t); },
    thumbCancel: () => { if (thumbs) thumbs.cancel(); },
  });
  thumbs = new Thumbs(ui.thumbCanvas, {
    allowed: () => !!P && !!P.view && P.engine.kind !== 'mpv' && thumbsAllowed({
      enabled: storeGet(THUMBS_KEY) !== '0', shell: P.engine.kind === 'mpv', duration: P.engine.state().duration,
      bandwidthKbps: knownBandwidthKbps(), torrentBuffering: !!P.torrent && P.engine.state().buffering,
    }),
    duration: () => (P ? P.engine.state().duration : 0),
    // Vidéo d'aperçu sur la même source : lien direct, ou une seconde session HLS du serveur (pour ne pas gêner la lecture).
    source: async () => {
      const p = P;
      if (!p || !p.mediaUrl || !p.choice || p.choice.engine === 'mpv') return null;
      if (p.choice.engine === 'hls') return { url: hlsMasterUrl(p.mediaBase || serverBase(), newSessionId(), p.mediaUrl, getCaps(), p.forceHls), hls: true };
      return { url: p.mediaUrl, hls: false };
    },
  });
  html = new HtmlEngine(ui.video);
  bindEngine(html);
  const v = Number(storeGet('laststream.player.volume'));
  if (Number.isFinite(v) && storeGet('laststream.player.volume') !== null) ui.video.volume = Math.min(1, Math.max(0, v));
  ui.video.autoPictureInPicture = storeGet(AUTOPIP_KEY) === '1';
  ui.setPipAvailable(html.supportsPip());
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('fullscreenchange', () => { if (P) refreshUI(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && P) saveProgress(true); });
  window.addEventListener('pagehide', () => { if (P) saveProgress(true); });
}

const rememberVolume = (v) => storeSet('laststream.player.volume', String(v));

function bindEngine(e) {
  e.on('state', () => { if (P && P.engine === e) refreshUI(); });
  e.on('ended', () => { if (P && P.engine === e) onEnded(); });
  e.on('error', (err) => { if (P && P.engine === e) failover('Erreur de lecture (' + (err && err.message ? err.message : 'inconnue') + ')'); });
  e.on('tracks', () => { if (P && P.engine === e) onTracks(); });
  e.on('ready', () => { if (P && P.engine === e) onReady(); });
}

// ---------- Ouverture ----------

/** Crée la session et ouvre le lecteur tout de suite, sans source : l'écran de chargement prend le relais. */
async function initSession(request, views, view, opts = {}) {
  ensureUI();
  if (P) await teardown(true);
  const token = Symbol('session');
  P = {
    token, req: request, views, ranked: [...views], cur: { season: request.season, episode: request.episode },
    view, tried: new Set(), attempts: 0, engine: html, choice: null, probe: null, probeTracks: parseProbe(null), mediaUrl: '',
    segments: [], nextDismissed: false, lastSave: 0, watchedMarked: false, finished: false,
    subs: {
      external: [], loadedFor: null, loading: false, selectedId: null, cues: [], offset: 0, rate: 1, rateId: 'none', shift: 0, rateHint: '',
      style: readSubStyle(), native: false, nativeCues: [], styleOpen: false, sync: { state: 'idle', message: '' }, syncKey: '',
    },
    defaultsDone: false, seasons: [], episodes: new Map(), opener: opts.opener || document.activeElement, failing: false,
    notice: opts.notice || '', forceHls: false, startedAt: 0, resumeTimer: null, imdb: request.imdb || '', epQuery: '', canonical: false,
    mark: { state: 'idle', kind: 'intro', start: 0 }, aspect: 'contain',
  };
  const meta = appState.byKey.get(request.key) || {};
  const model = appState.model && appState.model.key === request.key ? appState.model : null;
  P.model = model;
  P.meta = {
    poster: meta.posterPath || (model && model.posterPath) || '', backdrop: meta.backdropPath || (model && model.backdropPath) || '', title: request.name || meta.name || '',
    logo: (model && model.logo) || '', overview: (model && model.overview) || meta.overview || '',
  };
  document.body.classList.add('modal-open', 'lp-open');
  ui.root.classList.toggle('is-searching', !view);
  ui.root.classList.remove('is-mpv');
  ui.video.hidden = false;
  ui.video.style.objectFit = 'contain';
  ui.setHeading(...headingFor(P));
  ui.setSeries(request.type === 'tv', false);
  ui.setError(null);
  ui.setResume(null);
  ui.setSkip(null);
  ui.setNextCard(null);
  ui.setEndRow(false);
  ui.setCue('', P.subs.style);
  ui.show();
  ui.focusFirst();
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, 100);
  loadSideData(token);
  updatePauseScreen();
  if (request.type === 'tv') ensureEpisodes(request.season);
  return P;
}

/** Données du chargeur : logo, fond, épisode, étapes (sources trouvées → choix → lien) et ligne de source. */
function loaderExtra(step, over = {}) {
  const p = P;
  const found = p.views.length;
  return {
    logo: p.meta.logo, backdrop: p.meta.backdrop ? IMG('w1280', p.meta.backdrop) : '', episode: headingFor(p)[1], cancel: true,
    steps: [found ? found + ' source' + (found > 1 ? 's' : '') + ' trouvée' + (found > 1 ? 's' : '') : 'Recherche des sources', 'Choix de la meilleure source', 'Préparation du lien'],
    step, ...over,
  };
}

/** Poursuit la session avec la source choisie : reprise éventuelle puis lecture. */
function continueWith(view, opts = {}) {
  const p = P;
  p.view = view;
  p.notice = opts.notice || p.notice;
  ui.root.classList.remove('is-searching');
  const saved = userStore.getProgress(p.req.key, p.req.season ?? undefined, p.req.episode ?? undefined);
  const rd = resumeDecision(saved);
  const mode = opts.resume || 'ask';
  if (typeof opts.startAt === 'number') return playView(view, opts.startAt);
  if (rd.prompt && mode === 'ask') {
    ui.setLoading(null);
    ui.setResume(rd.position);
    p.resumeTimer = setTimeout(() => chooseResume(true), 12_000);
    return undefined;
  }
  return playView(view, rd.prompt && mode === 'auto' ? rd.position : 0);
}

/** Lance le lecteur sur `view` (sources déjà connues, par exemple choisies dans un tiroir). */
export async function startSession(request, views, view, opts = {}) {
  await initSession(request, views, view, opts);
  return continueWith(view, opts);
}

function chooseResume(resume) {
  if (!P || !P.resumeTimer) return;
  clearTimeout(P.resumeTimer);
  P.resumeTimer = null;
  const saved = userStore.getProgress(P.req.key, P.req.season ?? undefined, P.req.episode ?? undefined);
  const rd = resumeDecision(saved);
  ui.setResume(null);
  playView(P.view, resume ? rd.position : 0);
}

/** Données annexes chargées en parallèle : segments de saut, saisons. */
function loadSideData(token) {
  const p = P;
  const alive = () => P && P.token === token;
  (async () => {
    try {
      if (!p.imdb) p.imdb = (await imdbIdOf(p.req.type, p.req.id)) || '';
      if (p.imdb && isConfigured()) {
        const r = await skipSegments(p.req.type === 'tv' ? 'series' : 'movie', p.imdb, p.req.type === 'tv' ? p.req.season ?? 1 : 0, p.req.type === 'tv' ? p.req.episode ?? 1 : 0);
        if (alive()) p.segments = normalizeSkip(r);
      }
    } catch (_) { /* pas de segments : aucun bouton de saut */ }
  })();
  if (p.req.type === 'tv') loadSeasons().then(() => { if (alive()) ui.setSeries(true, !!nextRef()); });
}

/** Saisons : réponse canonique de lastAddon (TVDB / groupes TMDB), sinon saisons TMDB. */
async function loadSeasons() {
  const p = P;
  if (!p || p.seasons.length) return;
  try {
    const c = normalizeCanonical(await api('series/' + p.req.id + '/episodes', { language: getVideoLang().tag }));
    if (c && P === p) { p.seasons = c.seasons; p.episodes = c.episodes; p.canonical = true; return; }
  } catch (_) { /* repli TMDB */ }
  const m = p.model;
  let list = m && Array.isArray(m.seasons) ? m.seasons : null;
  if (!list) {
    try { const d = await tmdb('tv/' + p.req.id); list = d && d.seasons; } catch (_) { list = null; }
  }
  if (P !== p) return;
  p.seasons = (list || []).map((s) => ({ season: s.season_number, count: s.episode_count || 0 })).filter((s) => s.season > 0 && s.count > 0);
}

async function ensureEpisodes(season, reveal) {
  const p = P;
  if (!p || p.req.type !== 'tv') return;
  await loadSeasons();
  if (P !== p) return;
  const s = season ?? p.cur.season ?? 1;
  p.panelSeason = s;
  if (!p.episodes.has(s)) {
    p.episodesLoading = true;
    ui.refreshPanel();
    try {
      const d = await tmdb('tv/' + p.req.id + '/season/' + s);
      if (P !== p) return;
      const today = new Date().toISOString().slice(0, 10);
      p.episodes.set(s, (d.episodes || []).map((e) => ({
        episode: e.episode_number, name: e.name || '', runtime: e.runtime || null, overview: e.overview || '', still: IMG('w300', e.still_path),
        airDate: e.air_date || '', aired: !e.air_date || e.air_date <= today,
      })));
    } catch (_) { if (P === p) p.episodes.set(s, []); }
    if (P === p) p.episodesLoading = false;
  }
  if (P !== p) return;
  ui.setHeading(...headingFor(p));
  updatePauseScreen();
  ui.refreshPanel();
  if (reveal) ui.revealEpisode(s === p.cur.season ? p.cur.episode : 0);
}

/** Écran de pause : « Vous regardez… » avec le résumé de l'épisode (ou du film). */
function updatePauseScreen() {
  const p = P;
  if (!p) return;
  const eps = p.episodes.get(p.cur.season);
  const ep = eps && eps.find((e) => e.episode === p.cur.episode);
  const [title, sub] = headingFor(p);
  ui.setPauseScreen({ title, logo: p.meta.logo, episode: sub, synopsis: (ep && ep.overview) || p.meta.overview || '', backdrop: p.meta.backdrop ? IMG('w1280', p.meta.backdrop) : '' });
}

const nextRef = () => (P && P.req.type === 'tv' && P.cur.season != null ? nextEpisode(P.seasons, { season: P.cur.season, episode: P.cur.episode }) : null);

// ---------- Chargement d'une source ----------

async function resolveMedia(view) {
  const s = view.stream;
  const up = await serverAlive();
  const base = serverBase();
  const hints = s.behaviorHints || {};
  if (typeof s.url === 'string' && /^https?:\/\//i.test(s.url)) {
    const ph = hints.proxyHeaders;
    if (up && ph && typeof ph === 'object') return { url: proxyUrl(base, s.url, ph.request || {}, ph.response || {}), torrent: false, up, base };
    return { url: s.url, torrent: false, up, base };
  }
  if (typeof s.infoHash === 'string') {
    if (!up) throw new Error('Le serveur de streaming est indisponible : il est nécessaire pour lire un torrent.');
    const t = await createTorrent({ infoHash: s.infoHash, fileIdx: s.fileIdx, sources: Array.isArray(s.sources) ? s.sources : [], season: P.req.season, episode: P.req.episode }, base);
    return { url: t.url, torrent: true, up, base };
  }
  throw new Error('Cette source n’a ni lien ni identifiant de torrent.');
}

async function playView(view, startAt) {
  const p = P;
  if (!p) return;
  const token = p.token;
  const playId = (p.playId = (p.playId || 0) + 1);
  const stale = () => !P || P.token !== token || P.playId !== playId;
  p.view = view;
  p.tried.add(view.index);
  p.attempts += 1;
  p.defaultsDone = false;
  p.failing = false;
  p.autoNexting = false;
  p.startAt = startAt || 0;
  const s = p.subs;
  Object.assign(s, { selectedId: null, cues: [], nativeCues: [], native: false, loadedFor: null, external: [], offset: 0, rate: 1, rateId: 'none', shift: 0, rateHint: '', syncKey: '' });
  stopAutoSync();
  if (thumbs) thumbs.reset();
  p.torrent = false;
  if (p.engine) { try { p.engine.destroy(); } catch (_) { /* ignoré */ } }
  ui.setError(null);
  ui.root.classList.remove('is-searching');
  const base = loaderExtra(2, { source: sourceLine(view) + (view.status === 'cached' ? ' ⚡' : '') + ' — démarrage…' });
  ui.setLoading(p.meta.title || 'Lecture', 'Préparation du lien…', base);
  try {
    const shell = await connectShell();
    if (stale()) return;
    const media = await resolveMedia(view);
    if (stale()) return;
    p.mediaUrl = media.url;
    p.torrent = media.torrent;
    let probe = null;
    if (!shell && media.up) {
      ui.setLoading(p.meta.title || 'Lecture', media.torrent ? 'Connexion au torrent…' : 'Analyse du fichier…', base);
      probe = await fetchProbe(media.url, media.base);
      if (stale()) return;
    }
    p.probe = probe;
    p.probeTracks = parseProbe(probe);
    const choice = chooseEngine({
      torrent: media.torrent, shell: !!shell, serverUp: media.up, probe, caps: getCaps(), notWebReady: view.notWebReady,
      name: view.filename || media.url, forceTranscoding: p.forceHls,
      preferredLang: audioPreference()[0], audioTracksSupported: !!ui.video.audioTracks,
    });
    p.choice = choice;
    ui.setLoading(p.meta.title || 'Lecture', 'Moteur : ' + choice.label + '…', base);
    p.startedAt = Date.now();
    p.watch = new StallWatch(p.startedAt);
    ui.root.classList.toggle('is-mpv', choice.engine === 'mpv');
    if (choice.engine === 'mpv') {
      if (!mpv) { mpv = new MpvEngine(shell, ui.root); bindEngine(mpv); }
      p.engine = mpv;
      ui.video.hidden = true;
      await mpv.load({ url: media.url, startAt });
    } else {
      p.engine = html;
      ui.video.hidden = false;
      const hlsUrl = choice.engine === 'hls' ? hlsMasterUrl(media.base, newSessionId(), media.url, getCaps(), p.forceHls) : null;
      p.hlsQuery = choice.engine === 'hls' ? hlsQuery(media.url, getCaps(), p.forceHls) : '';
      p.hlsId = hlsUrl ? hlsUrl.split('/hlsv2/')[1].split('/')[0] : '';
      p.mediaBase = media.base;
      await html.load({ url: hlsUrl || media.url, hls: !!hlsUrl, startAt });
    }
    if (stale()) return;
    ui.setPipAvailable(p.engine.supportsPip());
    ui.setSeries(p.req.type === 'tv', !!nextRef());
    if (p.notice) { ui.toast(p.notice, 6000); p.notice = ''; }
    refreshUI();
  } catch (err) {
    if (stale()) return;
    failover(err && err.message ? err.message : 'Impossible de lancer la lecture');
  }
}

/** Repli automatique : copie équivalente d'abord, puis source suivante. */
function failover(reason) {
  const p = P;
  if (!p || p.failing) return;
  p.failing = true;
  const time = p.engine ? p.engine.state().time : 0;
  const options = failoverOrder(p.ranked, p.view, p.tried);
  if (!options.length || p.attempts >= MAX_ATTEMPTS) {
    try { p.engine.pause(); } catch (_) { /* ignoré */ }
    ui.setLoading(null);
    ui.setError('Lecture impossible', reason + '. Aucune autre source à essayer automatiquement.', [{ act: 'source', label: 'Essayer une autre source' }, { act: 'retry', label: 'Réessayer' }, { act: 'close', label: 'Fermer' }]);
    return;
  }
  const next = options[0];
  const label = [next.quality, next.sourceType, next.langs.map((l) => l.label).join('/')].filter(Boolean).join(' · ');
  ui.toast('Source indisponible, essai de la suivante : ' + label, 5000);
  playView(next, time > 5 ? time : p.startAt || 0);
}

// ---------- Événements moteur ----------

function onReady() {
  if (!P) return;
  ui.setLoading(null);
  if (!P.defaultsDone) setTimeout(() => P && applyDefaultTracks(true), 700);
}

function onTracks() {
  if (!P) return;
  if (!P.defaultsDone) applyDefaultTracks(false);
  ui.refreshPanel();
}

function allSubtitleTracks() {
  const s = P.subs;
  const fromEngine = P.engine.subtitleTracks();
  const embedded = fromEngine.length ? fromEngine : P.probeTracks.subtitles.filter((t) => /^(ass|ssa)$/.test(t.codec)).map((t) => ({
    ...t, url: embeddedSubtitleUrl(P.mediaBase || serverBase(), P.hlsId, t.engineId, P.hlsQuery || ''),
  }));
  return [...embedded.map((t) => ({ ...t, selected: t.id === s.selectedId })), ...s.external.map((t) => ({ ...t, selected: t.id === s.selectedId }))];
}

/** Piste audio et sous-titres initiaux, une seule fois par source (quand le moteur a annoncé ses pistes). */
function applyDefaultTracks(force) {
  const p = P;
  if (!p || p.defaultsDone) return;
  const audio = p.engine.audioTracks();
  const subs = allSubtitleTracks();
  if (!audio.length && !subs.length && !force) return;
  p.defaultsDone = true;
  const pref = audioPreference();
  let audioLang = audio.length ? '' : (p.view.hasFrench ? 'fr' : '');
  if (audio.length) {
    const i = pickDefaultAudio(audio, pref);
    if (i >= 0) {
      audioLang = audio[i].lang;
      if (!audio[i].selected) p.engine.setAudioTrack(audio[i].id);
    }
  }
  p.audioLang = audioLang;
  chooseDefaultSubtitle(subs, true);
  ensureExternalSubs(true);
}

function chooseDefaultSubtitle(tracks, quiet) {
  const p = P;
  const mem = getMemory(p.req.key);
  const idx = mem.sub ? pickRememberedSubtitle(tracks, mem.sub) : pickDefaultSubtitle(tracks, preferredLang(), p.audioLang || '', p.subs.style.mode);
  if (idx >= 0) selectSubtitle(tracks[idx].id, quiet);
}

/** Sous-titres externes (lastAddon, OpenSubtitles) ; `force` relance la recherche à la demande. */
async function ensureExternalSubs(auto, force) {
  const p = P;
  if (!p || p.subs.loading || (!force && p.subs.loadedFor === p.view.index)) return;
  p.subs.loading = true;
  ui.refreshPanel();
  const token = p.token;
  const view = p.view;
  try {
    let params = null;
    if (p.mediaUrl && (await serverAlive())) params = await fetchOpenSubParams(p.mediaUrl);
    const id = p.imdb ? (p.req.type === 'tv' ? stremioId(p.imdb, p.req.season ?? 1, p.req.episode ?? 1) : p.imdb) : '';
    if (!id) return;
    const type = p.req.type === 'tv' ? 'series' : 'movie';
    const addon = isConfigured() ? addonUrl('subtitles/' + type + '/' + id + '.json') : null;
    const list = await fetchExternalSubtitles({ type, id, hash: params && params.hash, size: (params && params.size) || view.sizeBytes || null, filename: view.filename }, addon, preferredLang());
    if (!P || P.token !== token || P.view !== view) return;
    p.subs.external = list;
    p.subs.loadedFor = view.index;
    if (auto && p.subs.selectedId === null && p.defaultsDone) chooseDefaultSubtitle(allSubtitleTracks(), true);
  } finally {
    if (P && P.token === token) { p.subs.loading = false; ui.refreshPanel(); }
  }
}

async function selectSubtitle(id, quiet) {
  const p = P;
  if (!p) return;
  const s = p.subs;
  s.selectedId = id || null;
  s.cues = [];
  s.nativeCues = [];
  s.native = false;
  s.offset = 0;
  s.rate = 1;
  s.rateId = 'none';
  s.shift = 0;
  s.rateHint = '';
  stopAutoSync();
  if (!id) {
    p.engine.setSubtitleTrack(null);
    if (!quiet) ui.toast('Sous-titres désactivés');
    ui.refreshPanel();
    return;
  }
  const track = allSubtitleTracks().find((t) => t.id === id);
  if (!track) return;
  s.syncKey = fileKey(p.view.filename || p.meta.title, p.view.sizeBytes) + '#' + (track.url || track.id);
  if (track.origin === 'embedded' && !track.url) {
    p.engine.setSubtitleTrack(track.id);
    s.native = true; // mpv les affiche lui-même ; hls.js : cues relues dans le calque (recalées par hls.js sur le fichier)
  } else {
    p.engine.setSubtitleTrack(null);
    // Les sous-titres extraits par le serveur gardent l'heure du fichier d'origine, dont le premier paquet n'est pas toujours à 0.
    if (track.origin === 'embedded') s.shift = -p.probeTracks.startTime;
    try {
      const up = await serverAlive();
      const base = serverBase();
      const via = up && track.origin === 'external' ? subtitlesVttUrl(base, track.url) : track.url;
      let text = '';
      try { text = await (await fetch(via)).text(); } catch (_) { text = await (await fetch(track.url)).text(); }
      if (P === p && s.selectedId === id) {
        s.cues = parseSubtitles(text, track.url);
        if (!s.cues.length) ui.toast('Ce sous-titre est vide ou illisible');
        else initialSync(track);
      }
    } catch (_) {
      if (P === p) ui.toast('Impossible de charger ce sous-titre');
    }
  }
  if (!quiet) ui.toast('Sous-titres : ' + track.label);
  ui.refreshPanel();
}

/** Calage d'une piste chargée : celui mémorisé pour ce fichier, sinon une correction de vitesse suggérée. */
function initialSync(track) {
  const p = P;
  const s = p.subs;
  const [file, sub] = s.syncKey.split('#');
  const saved = getSubSync(file, sub);
  if (saved) {
    s.offset = saved.offset;
    s.rate = saved.rate;
    s.rateId = (RATE_CHOICES.find((r) => Math.abs(r.ratio - saved.rate) < 1e-4) || RATE_CHOICES[0]).id;
    s.rateHint = 'Calage mémorisé pour ce fichier.';
    return;
  }
  const last = s.cues.length ? Math.max(...s.cues.map((c) => c.end)) : 0;
  const dur = p.engine.state().duration || p.probeTracks.durationSec || 0;
  const guess = suggestRate(last, dur);
  if (guess.id !== 'none') {
    s.rate = guess.ratio;
    s.rateId = guess.id;
    s.rateHint = 'Vitesse corrigée automatiquement (' + guess.label + ') : ces sous-titres semblent calés pour une autre cadence.';
    ui.toast('Sous-titres : vitesse corrigée (' + guess.label + ')', 4500);
  }
  void track;
}

function saveSync() {
  const s = P.subs;
  if (!s.syncKey) return;
  const [file, sub] = s.syncKey.split('#');
  setSubSync(file, sub, { offset: s.offset, rate: s.rate });
}

// ---------- Synchronisation automatique (parole ↔ sous-titres) ----------

function stopAutoSync() {
  const sy = P && P.subs.sync;
  if (sy && sy.probe) sy.probe.stop();
  if (P) P.subs.sync = { state: 'idle', message: '' };
}

function startAutoSync() {
  const p = P;
  const sup = levelProbeSupported(ui.video);
  if (!sup.ok) { p.subs.sync = { state: 'idle', message: sup.reason }; ui.refreshPanel(); return; }
  const probe = createLevelProbe(ui.video);
  if (!probe.ok) { p.subs.sync = { state: 'idle', message: probe.reason }; ui.refreshPanel(); return; }
  probe.start();
  p.subs.sync = { state: 'collecting', probe, message: '' };
  p.engine.play();
  ui.toast('Analyse lancée : laisse la lecture avancer', 3500);
  ui.refreshPanel();
}

function finishAutoSync() {
  const p = P;
  const sy = p.subs.sync;
  if (!sy.probe) return;
  const samples = sy.probe.samples;
  sy.probe.stop();
  const cues = p.subs.native ? p.subs.nativeCues : p.subs.cues;
  const res = findSync(samples, cues, { rates: [1, RATE_CHOICES[1].ratio, RATE_CHOICES[2].ratio] });
  if (syncTrusted(res)) {
    p.subs.offset = Math.round((res.offset - p.subs.shift) * 10) / 10;
    p.subs.rate = res.rate;
    p.subs.rateId = (RATE_CHOICES.find((r) => Math.abs(r.ratio - res.rate) < 1e-4) || RATE_CHOICES[0]).id;
    saveSync();
    const sign = p.subs.offset > 0 ? '+' : '';
    p.subs.sync = { state: 'idle', message: 'Calé automatiquement : ' + sign + p.subs.offset.toFixed(1).replace('.', ',') + ' s' + (res.rate !== 1 ? ' et vitesse corrigée' : '') + '.' };
    ui.toast('Sous-titres calés (' + sign + p.subs.offset.toFixed(1).replace('.', ',') + ' s)', 4000);
  } else {
    p.subs.sync = { state: 'idle', message: 'Résultat peu fiable : réessaie sur une scène avec beaucoup de dialogues.' };
  }
  ui.refreshPanel();
}

function onEnded() {
  const p = P;
  if (!p || p.finished) return;
  saveProgress(true);
  markWatched();
  const nx = nextRef();
  if (nx && getSkipPref('nextEpisode')) { playEpisode(nx.season, nx.episode); return; }
  p.finished = true;
  const key = p.req.key;
  closePlayer();
  setTimeout(() => showRatePrompt(key), 600);
}

// ---------- Boucle périodique ----------

let tickN = 0;
function tick() {
  const p = P;
  if (!p || !p.engine || !p.view) return;
  const st = p.engine.state();
  tickN += 1;
  // Sous-titres (100 ms).
  const s = p.subs;
  let cues = s.cues;
  if (s.native && p.engine.kind === 'html') {
    if (tickN % 5 === 0) s.nativeCues = p.engine.nativeCues();
    cues = s.nativeCues || [];
  }
  const cue = s.native && p.engine.kind === 'mpv' ? null : activeCue(cues, st.time, s.offset + s.shift, s.rate);
  ui.setCue(cue ? cueHtml(cue.text) : '', s.style);
  if (tickN % 3 === 0) refreshUI(st);
  if (tickN % 10 !== 0) return;
  // Chaque seconde : blocage, saut, carte suivante, progression.
  if (p.choice && !p.failing && !p.resumeTimer) {
    const verdict = p.watch.tick(Date.now(), st.time, st.paused || st.ended || st.seeking);
    if (verdict === 'stalled') failover('La lecture est bloquée depuis plus de 15 s');
    else if (verdict === 'startup-timeout') failover('La source met trop de temps à démarrer');
  }
  if (st.time > 0 && !st.buffering) ui.setLoading(null);
  if (s.sync.state === 'collecting') {
    const secs = s.sync.probe.seconds();
    if (secs >= AUTOSYNC_TARGET) finishAutoSync(); else ui.refreshPanel();
  }
  if (st.duration > 0) {
    const seg = activeSkip(p.segments, st.time);
    if (seg && autoSkipEnabled(seg.kind, getSkipPref, seg.inferred) && p.skipped !== seg.start && p.undone !== seg.start) {
      p.skipped = seg.start;
      p.engine.seek(seg.end);
      p.watch.reset(Date.now());
      ui.toast((seg.kind === 'intro' ? 'Intro passée' : 'Récap passé'), 3000, { label: 'Annuler', run: () => { p.undone = seg.start; p.engine.seek(seg.start); } });
    }
    ui.setSkip(seg && p.skipped !== seg.start ? seg : null);
    const nx = nextRef();
    const card = nextEpisodeCard(p.segments, st.time, st.duration, !!nx, getSkipPref('nextEpisode'));
    if (card.show && !p.nextDismissed && nx) {
      const ep = p.episodes.get(nx.season);
      const info = ep && ep.find((e) => e.episode === nx.episode);
      ui.setNextCard({ title: 'S' + nx.season + ':É' + nx.episode + (info && info.name ? ' « ' + info.name + ' »' : ''), still: info ? info.still : '', countdown: card.countdown, ratio: card.ratio });
      if (!ep) ensureEpisodes(nx.season);
      if (card.countdown === 0 && !p.autoNexting) { p.autoNexting = true; playEpisode(nx.season, nx.episode); }
    } else ui.setNextCard(null);
    ui.setEndRow(p.req.type === 'movie' && !p.endDismissed && movieEndRow(p.segments, st.time, st.duration));
    if (!st.paused) saveProgress(false, st);
    if (!p.watchedMarked && isWatched(st.time, st.duration)) markWatched();
  }
}

function refreshUI(st) {
  if (!P || !P.engine || !P.view) return;
  const s = st || P.engine.state();
  ui.update(s, chapterMarks(P.segments, s.duration));
}

// ---------- Progression ----------

function saveProgress(force, st) {
  const p = P;
  if (!p || !p.engine || !p.view) return;
  const s = st || p.engine.state();
  if (!shouldSave(Date.now(), p.lastSave, force, s.duration) || s.time <= 1) return;
  p.lastSave = Date.now();
  const it = appState.byKey.get(p.req.key) || {};
  userStore.setProgress({
    key: p.req.key, type: p.req.type, id: Number(p.req.id), title: p.meta.title || it.name || '', poster: p.meta.poster || it.posterPath || '',
    backdrop: p.meta.backdrop || it.backdropPath || '', season: p.cur.season != null ? p.cur.season : undefined, episode: p.cur.episode != null ? p.cur.episode : undefined,
    position: s.time, duration: s.duration,
  });
}

function markWatched() {
  const p = P;
  if (!p || p.watchedMarked) return;
  p.watchedMarked = true;
  const refs = p.req.type === 'tv' && p.cur.season != null ? [{ season: p.cur.season, episode: p.cur.episode }] : null;
  Promise.resolve(userStore.setWatched(p.req.key, refs, true)).catch(() => {});
}

// ---------- Actions ----------

function seekTo(t) {
  if (!P || !P.view) return;
  P.engine.seek(t);
  P.watch.reset(Date.now());
  P.skipped = null;
}

function seekBy(d) {
  if (!P || !P.view) return;
  const st = P.engine.state();
  const to = Math.min(st.duration || Infinity, Math.max(0, st.time + d));
  seekTo(to);
  ui.toast((d > 0 ? '+' : '−') + Math.abs(d) + ' s', 900);
  ui.previewTime(to);
}

function togglePlay() {
  if (!P || !P.view) return;
  const st = P.engine.state();
  if (st.paused) P.engine.play(); else { P.engine.pause(); saveProgress(true); }
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await ui.root.requestFullscreen();
  } catch (_) { ui.toast('Plein écran indisponible'); }
}

async function togglePip() {
  if (!P || !P.view || !P.engine.supportsPip()) { ui.toast('Image dans l’image indisponible ici'); return; }
  try { await P.engine.togglePip(); } catch (_) { ui.toast('Image dans l’image refusée par le navigateur'); }
}

/** Sélecteur de sources dans un panneau du lecteur : recherche initiale sans résultat, lecture automatique désactivée, changement de source. */
function showSourcesPanel() {
  const p = P;
  if (!p) return;
  ui.setLoading(null);
  ui.root.classList.remove('is-searching');
  const host = ui.mountPanel('sources', 'Sources');
  openSourcePicker(p.req, null, {
    host, views: p.views, currentIndex: p.view ? p.view.index : null,
    onPick: (view, views) => {
      if (!P || P.token !== p.token) return;
      ui.closePanel(true);
      p.views = views;
      p.ranked = [...views];
      if (!p.view) { p.req.imdb = p.req.imdb || p.imdb; continueWith(view, { resume: p.resumeMode || 'ask' }); return; }
      if (view.index === p.view.index) { ui.focusFirst(); return; }
      const st = p.engine.state();
      p.attempts = 0;
      p.tried = new Set();
      ui.toast('Changement de source…');
      playView(view, st.time > 5 ? st.time : 0);
      ui.focusFirst();
    },
  });
}

/** Épisode d'une série : même ouverture immédiate que « Lecture », sans reprise proposée. */
function playEpisode(season, episode) {
  const p = P;
  if (!p) return Promise.resolve();
  ui.closePanel(true);
  return playBest({ ...p.req, season, episode, imdb: p.imdb }, p.opener, { resume: 'none' });
}

function submitTarget() {
  const p = P;
  return { type: p.req.type === 'tv' ? 'series' : 'movie', imdbId: p.imdb, season: p.req.type === 'tv' ? p.cur.season ?? 1 : 0, episode: p.req.type === 'tv' ? p.cur.episode ?? 1 : 0 };
}

async function sendSegment(kind, start, end, negative) {
  const p = P;
  const body = buildSubmission(submitTarget(), kind, start, end, p.engine.state().duration, negative);
  if (!body) { ui.toast('Segment invalide : il doit durer au moins 3 s'); return false; }
  try {
    await postLt('skip/submit', body);
    if (negative) {
      p.segments = p.segments.filter((s) => !(s.kind === kind && s.inferred));
      ui.setSkip(null);
      ui.toast('Merci, signalé : ce segment ne sera plus proposé');
    } else {
      p.segments = [...p.segments.filter((s) => s.kind !== kind), { kind, start: body.start, end: body.end }].sort((a, b) => a.start - b.start);
      ui.toast('Merci, segment envoyé et utilisable tout de suite');
    }
    return true;
  } catch (_) {
    ui.toast('Envoi impossible pour le moment');
    return false;
  }
}

function onAction(act, data) {
  if (!P) return;
  if (act === 'close') { closePlayer(); return; }
  if (act === 'source') { showSourcesPanel(); return; }
  if (!P.view) return; // recherche en cours : seuls « Annuler » et le choix de source sont possibles
  const st = P.engine.state();
  const s = P.subs;
  switch (act) {
    case 'toggle-play': togglePlay(); break;
    case 'back10': seekBy(-10); break;
    case 'fwd10': seekBy(10); break;
    case 'mute': P.engine.setMuted(!st.muted); break;
    case 'fullscreen': toggleFullscreen(); break;
    case 'pip': togglePip(); break;
    case 'info': ui.togglePanel('info'); break;
    case 'skip': { const seg = activeSkip(P.segments, st.time); if (seg) { seekTo(seg.end); ui.toast('Passé'); } break; }
    case 'skip-wrong': { const seg = activeSkip(P.segments, st.time); if (seg) sendSegment(seg.kind, seg.start, seg.end, true); break; }
    case 'next': { const nx = nextRef(); if (nx) playEpisode(nx.season, nx.episode); else ui.toast('Dernier épisode'); break; }
    case 'next-dismiss': P.nextDismissed = true; ui.setNextCard(null); break;
    case 'end-dismiss': P.endDismissed = true; ui.setEndRow(false); break;
    case 'more-info': case 'recs': {
      const key = P.req.key;
      closePlayer();
      setTimeout(() => {
        if (location.hash !== '#/' + key.replace(':', '/')) location.hash = '#/' + key.replace(':', '/');
        if (act === 'recs') setTimeout(() => { const el = document.querySelector('#detail [data-tab="recs"], #detail .f-recs, #detail #f-recs'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 700);
      }, 50);
      break;
    }
    case 'resume': chooseResume(true); break;
    case 'restart': chooseResume(false); break;
    case 'retry': { const v = P.view; P.tried = new Set(); P.attempts = 0; playView(v, st.time > 5 ? st.time : 0); break; }
    case 'audio': {
      const t = P.engine.audioTracks().find((x) => x.id === data.id);
      if (t && t.lang) remember(P.req.key, { audio: t.lang });
      P.engine.setAudioTrack(data.id);
      P.watch.reset(Date.now());
      setTimeout(() => ui.refreshPanel(), 200);
      ui.toast('Audio : ' + (t ? t.label : ''));
      break;
    }
    case 'force-hls': P.forceHls = true; ui.closePanel(true); ui.toast('Passage en transcodage…'); P.tried = new Set(); playView(P.view, st.time > 5 ? st.time : 0); break;
    case 'sub': {
      const t = data.id ? allSubtitleTracks().find((x) => x.id === data.id) : null;
      remember(P.req.key, { sub: t ? t.lang || 'off' : 'off' });
      selectSubtitle(data.id || null);
      break;
    }
    case 'subsearch': ensureExternalSubs(false, true); break;
    case 'suboffset': s.offset = Math.max(-120, Math.min(120, Math.round((s.offset + Number(data.by)) * 10) / 10)); saveSync(); ui.refreshPanel(); break;
    case 'suboffset-reset': s.offset = 0; s.rate = 1; s.rateId = 'none'; s.rateHint = ''; saveSync(); ui.refreshPanel(); break;
    case 'subrate': { const r = rateChoice(data.id); s.rate = r.ratio; s.rateId = r.id; s.rateHint = ''; saveSync(); ui.refreshPanel(); break; }
    case 'autosync': startAutoSync(); break;
    case 'autosync-now':
      if (s.sync.probe && s.sync.probe.seconds() >= AUTOSYNC_MIN) finishAutoSync(); else ui.toast('Encore un peu de lecture (' + AUTOSYNC_MIN + ' s minimum)');
      break;
    case 'autosync-cancel': stopAutoSync(); ui.refreshPanel(); break;
    case 'style-open': s.styleOpen = data.open === '1'; break;
    case 'substyle': updateStyle({ [data.key]: data.key === 'size' ? Number(data.val) : data.val }); break;
    case 'substep': updateStyle({ [data.key]: s.style[data.key] + Number(data.by) }); break;
    case 'rate': P.engine.setRate(Number(data.rate)); setTimeout(() => ui.refreshPanel(), 50); break;
    case 'thumbs': storeSet(THUMBS_KEY, storeGet(THUMBS_KEY) === '0' ? '1' : '0'); thumbs.cancel(); ui.refreshPanel(); break;
    case 'aspect': P.aspect = data.val; ui.video.style.objectFit = data.val; ui.refreshPanel(); break;
    case 'autopip': { const on = storeGet(AUTOPIP_KEY) !== '1'; storeSet(AUTOPIP_KEY, on ? '1' : '0'); ui.video.autoPictureInPicture = on; ui.refreshPanel(); break; }
    case 'season': ensureEpisodes(Number(data.season)); break;
    case 'episode': playEpisode(Number(data.season), Number(data.episode)); break;
    case 'epsearch': P.epQuery = data.q || ''; ui.refreshPanel(); break;
    case 'ep-seen': {
      Promise.resolve(userStore.setWatched(P.req.key, [{ season: Number(data.season), episode: Number(data.episode) }], data.seen === '1')).then(() => ui.refreshPanel());
      break;
    }
    case 'ep-season-seen': {
      const sn = Number(data.season);
      const aired = (P.episodes.get(sn) || []).filter((e) => e.aired);
      const all = aired.every((e) => userStore.isWatched(P.req.key, sn, e.episode));
      Promise.resolve(userStore.setWatched(P.req.key, aired.map((e) => ({ season: sn, episode: e.episode })), !all)).then(() => { ui.refreshPanel(); ui.toast(all ? 'Saison marquée non vue' : 'Saison marquée comme vue'); });
      break;
    }
    case 'ep-next-unseen': {
      const from = firstUnseen(P.seasons, P.episodes, P.panelSeason ?? P.cur.season ?? 1, (sn, e) => userStore.isWatched(P.req.key, sn, e));
      if (!from) { ui.toast('Tous les épisodes diffusés sont vus'); break; }
      P.epQuery = '';
      ensureEpisodes(from.season).then(() => ui.revealEpisode(from.episode));
      break;
    }
    case 'mark-kind': P.mark.kind = data.val; ui.refreshPanel(); break;
    case 'mark-start': P.mark = { ...P.mark, state: 'start', start: st.time }; ui.toast('Début noté à ' + formatClock(st.time)); ui.refreshPanel(); break;
    case 'mark-cancel': P.mark.state = 'idle'; ui.refreshPanel(); break;
    case 'mark-end': {
      const m = P.mark;
      sendSegment(m.kind, m.start, st.time, false).then((ok) => { if (ok) { P.mark.state = 'idle'; ui.refreshPanel(); } });
      break;
    }
    default: break;
  }
}

function updateStyle(patch) {
  const next = normalizeSubStyle({ ...P.subs.style, ...patch });
  P.subs.style = next;
  writeSubStyle(next);
  ui.refreshPanel();
}

// ---------- Panneaux ----------

function panelData(name) {
  const p = P;
  if (!p || !p.view) return {};
  if (name === 'tracks') {
    const tracks = p.engine.audioTracks();
    const hasApi = p.engine.kind !== 'html' || !!ui.video.audioTracks || !!p.engine.hls;
    const titles = {};
    tracks.forEach((t) => { titles[t.id] = t.title || ''; });
    const subTracks = allSubtitleTracks();
    subTracks.forEach((t) => { titles[t.id] = t.title || ''; });
    const s = p.subs;
    const cues = s.native ? s.nativeCues : s.cues;
    const sup = levelProbeSupported(ui.video);
    const sync = s.sync;
    return {
      audio: {
        groups: groupAudioTracks(tracks, audioPreference(), titles),
        note: hasApi ? 'Une seule piste audio dans ce flux.' : 'Ce navigateur n’expose pas les pistes audio d’un fichier lu directement.',
        canTranscode: !tracks.length && !hasApi && p.choice && p.choice.engine === 'direct',
      },
      subs: {
        sections: sectionSubtitleTracks(subTracks, [preferredLang()], titles), selectedId: s.selectedId, offset: s.offset, rate: s.rateId, rateHint: s.rateHint,
        style: s.style, styleOpen: s.styleOpen, loading: s.loading,
        sync: {
          canAuto: !!s.selectedId && cues.length > 0 && sup.ok && p.engine.kind === 'html', reason: !s.selectedId ? 'Choisis d’abord une piste de sous-titres.' : !cues.length ? 'Pas de texte à caler pour cette piste.' : sup.reason || (p.engine.kind !== 'html' ? 'Indisponible avec mpv.' : ''),
          state: sync.state, message: sync.message, seconds: sync.probe ? sync.probe.seconds() : 0, target: AUTOSYNC_TARGET,
        },
      },
    };
  }
  if (name === 'settings') {
    const v = p.view;
    const st = p.engine.state();
    const web = v.web === 'direct' ? { html: '<b class="lp-tag is-sync">Lecture directe</b>' } : v.web === 'convert' ? { html: '<b class="lp-tag is-warn">Conversion</b>' } : null;
    const rows = [
      ['Résolution', [v.quality, v.sourceType].filter(Boolean).join(' · ') || 'Inconnue'],
      ['Codec', [v.codec, ...v.hdr].filter(Boolean).join(' · ') || 'Inconnu'],
      ['Débit', [v.bitrateLabel, v.sizeLabel].filter(Boolean).join(' · ') || 'Inconnu'],
      ['Langue', v.langs.map((l) => l.label + (l.verified ? ' ✓' : '')).join(', ') || 'Inconnue'],
      ['Fournisseur', v.provider || v.statusLabel],
    ];
    if (web) rows.push(['Lecture', web]);
    if (p.choice) rows.push(['Moteur', p.choice.label]);
    return {
      rate: st.rate, source: rows, aspect: p.aspect, thumbs: storeGet(THUMBS_KEY) !== '0', autoPip: storeGet(AUTOPIP_KEY) === '1', pipAvailable: p.engine.supportsPip(),
      canMark: !!p.imdb && isConfigured(), mark: { ...p.mark, at: formatClock(st.time), startLabel: formatClock(p.mark.start) },
    };
  }
  if (name === 'episodes') {
    const s = p.panelSeason ?? p.cur.season ?? 1;
    const all = (p.episodes.get(s) || []).map((e) => {
      const pr = userStore.getProgress(p.req.key, s, e.episode);
      return { ...e, watched: userStore.isWatched(p.req.key, s, e.episode), progress: pr && pr.duration ? pr.position / pr.duration : 0 };
    });
    return {
      seasons: p.seasons, season: s, episodes: filterEpisodes(all, p.epQuery), loading: !!p.episodesLoading, current: p.cur, query: p.epQuery,
      logo: p.meta.logo, title: p.meta.title, total: all.length, watchedCount: all.filter((e) => e.watched).length,
    };
  }
  if (name === 'info') {
    const v = p.view;
    const eps = p.episodes.get(p.cur.season);
    const ep = eps && eps.find((e) => e.episode === p.cur.episode);
    const [title, sub] = headingFor(p);
    const rows = [
      ['Moteur', p.choice ? p.choice.label : '…'],
      ['Qualité', [v.quality, v.sourceType, v.codec, ...v.hdr].filter(Boolean).join(' · ')],
      ['Audio', v.audio || 'Inconnu'],
      ['Taille', [v.sizeLabel, v.bitrateLabel, v.durationLabel && '≈ ' + v.durationLabel].filter(Boolean).join(' · ') || 'Inconnue'],
      ['Statut', v.statusLabel],
      ['Fichier', v.filename || '—'],
    ];
    if (v.releaseGroup) rows.push(['Release', v.releaseGroup]);
    if (p.probeTracks.height) rows.push(['Vidéo', p.probeTracks.width + '×' + p.probeTracks.height + ' · ' + (p.probeTracks.videoCodec || '').toUpperCase()]);
    if (p.choice) rows.push(['Pourquoi ce moteur', p.choice.reason]);
    rows.push(['Serveur de streaming', serverBase()]);
    const m = p.model;
    return {
      title, episode: sub, synopsis: (ep && ep.overview) || p.meta.overview, rating: m && m.vote ? Number(m.vote).toFixed(1) + ' / 10' : '',
      cast: m && Array.isArray(m.cast) ? m.cast.slice(0, 12) : [], rows,
    };
  }
  return {};
}

// ---------- Clavier ----------

function onKey(e) {
  if (!P || ui.root.hidden) return;
  const modal = document.getElementById('modal');
  if (modal && !modal.hidden) return; // une fenêtre de l'application (note, etc.) gère ses propres touches
  const t = e.target instanceof Element ? e.target : null;
  const typing = !!(t && t.closest('input[type="text"], textarea, select'));
  const onButton = !!(t && t.closest('button'));
  // Le sélecteur de sources (dans un panneau) gère lui-même ses flèches ; Échap le ferme.
  if (ui.panel === 'sources' && e.key !== 'Escape' && e.key !== 'Backspace' && /^(Arrow|Home$|End$)/.test(e.key)) return;
  const action = keyToAction(e.key, { panelOpen: !!ui.panel, typing, onButton }, { ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey });
  ui.wake();
  if (!action) return;
  if (action.type === 'wake') return;
  if (action.type === 'nav') { e.preventDefault(); e.stopImmediatePropagation(); ui.navPanel(action.dir); return; }
  e.preventDefault();
  e.stopImmediatePropagation();
  if (!P.view && action.type !== 'back') return;
  const st = P.view ? P.engine.state() : null;
  switch (action.type) {
    case 'toggle-play': togglePlay(); break;
    case 'seek': seekBy(action.by); break;
    case 'volume': { P.engine.setMuted(false); const v = stepVolume(st.volume, action.by); P.engine.setVolume(v); rememberVolume(v); ui.toast('Volume ' + Math.round(v * 100) + ' %', 900); break; }
    case 'fullscreen': toggleFullscreen(); break;
    case 'mute': P.engine.setMuted(!st.muted); break;
    case 'skip': onAction('skip'); break;
    case 'pip': togglePip(); break;
    case 'panel': ui.togglePanel(action.name); break;
    case 'next': onAction('next'); break;
    case 'back':
      if (ui.panel) ui.closePanel();
      else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else closePlayer();
      break;
    default: break;
  }
}

// ---------- Fermeture ----------

async function teardown(silent) {
  const p = P;
  if (!p) return;
  saveProgress(true);
  clearInterval(tickTimer);
  clearTimeout(p.resumeTimer);
  stopAutoSync();
  if (thumbs) thumbs.reset();
  try { p.engine.destroy(); } catch (_) { /* ignoré */ }
  if (document.pictureInPictureElement) { try { await document.exitPictureInPicture(); } catch (_) { /* ignoré */ } }
  P = null;
  if (!silent) {
    if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch (_) { /* ignoré */ } }
    ui.hide();
    document.body.classList.remove('modal-open', 'lp-open');
  }
}

export function closePlayer() {
  if (!P) return;
  const p = P;
  const watched = p.watchedMarked;
  const key = p.req.key;
  const opener = p.opener;
  teardown(false).then(() => {
    if (opener && opener.isConnected && opener.focus) opener.focus({ preventScroll: true });
    if (watched && !p.finished) setTimeout(() => showRatePrompt(key), 600);
  });
}

export const isPlayerOpen = () => !!P;

// ---------- Lecture automatique (bouton « Lecture ») ----------

/**
 * Ouvre le lecteur tout de suite ; la recherche de sources et le choix de la meilleure (débit, langue, lecture directe)
 * se font dans l'écran de chargement. Réglage « lecture automatique » désactivé, aucune source ou aucune qui convienne :
 * le sélecteur s'ouvre dans un panneau du lecteur. « Annuler » ramène à la fiche.
 */
export async function playBest(request, opener, opts = {}) {
  const p = await initSession(request, [], null, { opener });
  const token = p.token;
  const alive = () => P && P.token === token;
  p.resumeMode = opts.resume || 'ask';
  ui.setLoading(p.meta.title || 'Lecture', 'Recherche de la meilleure source…', loaderExtra(0));
  let loaded = null;
  try {
    if (userStore.loadProgress) await userStore.loadProgress(request.key);
    loaded = await loadSources(request);
  } catch (_) { loaded = null; }
  if (!alive()) return;
  if (!loaded || !loaded.views.length) { showSourcesPanel(); return; }
  request.imdb = loaded.imdb;
  p.imdb = loaded.imdb;
  p.views = loaded.views;
  p.ranked = [...loaded.views];
  if (opts.picker || (!getAutoplay() && !opts.force)) { showSourcesPanel(); return; }
  ui.setLoading(p.meta.title || 'Lecture', 'Choix de la meilleure source…', loaderExtra(1));
  const bw = await measureBandwidthKbps().catch(() => null);
  if (!alive()) return;
  const rec = recommendFor(loaded.views, bw);
  if (!rec) { showSourcesPanel(); return; }
  ui.setLoading(p.meta.title || 'Lecture', rec.reason, loaderExtra(2, { source: sourceLine(rec.view) + (rec.view.status === 'cached' ? ' ⚡' : '') + ' — démarrage…' }));
  await continueWith(rec.view, { resume: p.resumeMode, notice: rec.languageFallback ? rec.reason : '' });
}

/** Lance une source choisie dans le sélecteur de la fiche. */
export function playSource(request, views, view, opener, opts = {}) {
  return startSession(request, views, view, { opener, resume: opts.resume || 'ask' });
}

export { formatClock };
