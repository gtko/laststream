/* Session de lecture : choisit le moteur, charge la source, suit la progression, saute les génériques, bascule sur une
 * autre copie en cas d'échec, gère pistes audio, sous-titres, épisodes. L'interface est dans ui.js. */
import { addonUrl, isConfigured } from '../data/config';
import { skipSegments, tmdb } from '../data/lt';
import { getAutoplay, getSkipPref } from '../data/prefs';
import { measureBandwidthKbps } from '../data/sources';
import { stremioId } from '../data/sources';
import { userStore } from '../data/userStore';
import { openSourcePicker } from '../sources/picker.js';
import { loadSources, preferredLang, recommendFor } from '../sources/load';
import { IMG } from '../ui/constants.js';
import { toast as appToast } from '../ui/dom.js';
import { showRatePrompt } from '../ui/rate.js';
import { state as appState } from '../ui/state.js';
import { chooseEngine, detectCaps } from './engine';
import { HtmlEngine, MpvEngine } from './engines.js';
import { fetchExternalSubtitles } from './extsubs';
import { StallWatch, failoverOrder } from './failover';
import { getMemory, remember } from './memory';
import { keyToAction, stepVolume } from './keys';
import { formatClock, isWatched, nextEpisode, resumeDecision, shouldSave } from './progress';
import { connectShell } from './shell';
import { activeSkip, autoSkipEnabled, chapterMarks, movieEndRow, nextEpisodeCard, normalizeSkip } from './skip';
import {
  createTorrent, embeddedSubtitleUrl, fetchOpenSubParams, fetchProbe, hlsMasterUrl, hlsQuery, newSessionId, proxyUrl,
  serverAlive, serverBase, subtitlesVttUrl,
} from './server';
import { activeCue, cueHtml, normalizeSubStyle, parseSubtitles, readSubStyle, stepOffset, writeSubStyle } from './subs';
import { parseProbe, pickDefaultAudio, pickDefaultSubtitle, pickRememberedSubtitle } from './tracks';
import { createPlayerUI } from './ui.js';

const AUTOPIP_KEY = 'laststream.player.autopip';
const MAX_ATTEMPTS = 6;

let ui = null;
let html = null;
let mpv = null;
let P = null; // session courante (null : lecteur fermé)
let tickTimer = null;
let caps = null;

const storeGet = (k) => { try { return globalThis.localStorage.getItem(k); } catch (_) { return null; } };
const storeSet = (k, v) => { try { globalThis.localStorage.setItem(k, v); } catch (_) { /* ignoré */ } };

/** Langues audio à essayer : choix mémorisé pour ce titre, puis langue préférée des réglages. */
function audioPreference() {
  const mem = P ? getMemory(P.req.key) : {};
  return [mem.audio, preferredLang()].filter(Boolean);
}

function getCaps() {
  if (!caps) {
    const v = document.createElement('video');
    const chromium = !!window.chrome;
    let ch = 2;
    if (/firefox/i.test(navigator.userAgent)) ch = 6;
    else if (window.AudioContext && !chromium) { try { ch = new AudioContext().destination.maxChannelCount || 2; } catch (_) { ch = 2; } }
    caps = detectCaps((m) => v.canPlayType(m), { chromium, maxChannels: ch });
  }
  return caps;
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
    panelOpened: (name) => { if (name === 'tracks') ensureExternalSubs(); if (name === 'episodes') ensureEpisodes(P && P.cur.season); },
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

/**
 * Lance le lecteur sur `view`. `request` décrit le titre ; `views` toutes les sources (pour le failover et « Changer de source »).
 * `opts.resume` : 'ask' (proposer), 'auto' (reprendre sans demander), 'none' (depuis le début).
 */
export async function startSession(request, views, view, opts = {}) {
  ensureUI();
  if (P) await teardown(true);
  const token = Symbol('session');
  P = {
    token, req: request, views, ranked: [...views], cur: { season: request.season, episode: request.episode },
    view, tried: new Set(), attempts: 0, engine: html, choice: null, probe: null, probeTracks: parseProbe(null), mediaUrl: '', hlsSession: null,
    segments: [], nextDismissed: false, lastSave: 0, watchedMarked: false, finished: false,
    subs: { external: [], loadedFor: null, loading: false, selectedId: null, cues: [], offset: 0, style: readSubStyle(), native: false, embedded: [] },
    defaultsDone: false, seasons: [], episodes: new Map(), opener: opts.opener || document.activeElement, failing: false,
    notice: opts.notice || '', forceHls: false, startedAt: 0, resumeTimer: null, imdb: request.imdb || '',
  };
  const meta = appState.byKey.get(request.key) || {};
  const model = appState.model && appState.model.key === request.key ? appState.model : null;
  P.meta = {
    poster: meta.posterPath || (model && model.posterPath) || '', backdrop: meta.backdropPath || (model && model.backdropPath) || '', title: request.name || meta.name || '',
    logo: (model && model.logo) || '', overview: (model && model.overview) || meta.overview || '',
  };
  document.body.classList.add('modal-open', 'lp-open');
  ui.setHeading(...headingFor(P));
  ui.setSeries(request.type === 'tv', false);
  ui.setError(null);
  ui.setResume(null);
  ui.setSkip(null);
  ui.setNextCard(null);
  ui.show();
  ui.focusFirst();
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, 100);
  loadSideData(token);
  updatePauseScreen();
  if (request.type === 'tv') ensureEpisodes(request.season);
  const saved = request.type && userStore.getProgress(request.key, request.season ?? undefined, request.episode ?? undefined);
  const rd = resumeDecision(saved);
  const mode = opts.resume || 'ask';
  if (typeof opts.startAt === 'number') return playView(view, opts.startAt);
  if (rd.prompt && mode === 'ask') {
    ui.setLoading(null);
    ui.setResume(rd.position);
    P.resumeTimer = setTimeout(() => chooseResume(true), 12_000);
    return undefined;
  }
  return playView(view, rd.prompt && mode === 'auto' ? rd.position : 0);
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
      if (!p.imdb) {
        const { imdbIdOf } = await import('../data/sources');
        p.imdb = (await imdbIdOf(p.req.type, p.req.id)) || '';
      }
      if (p.imdb && isConfigured()) {
        const r = await skipSegments(p.req.type === 'tv' ? 'series' : 'movie', p.imdb, p.req.type === 'tv' ? p.req.season ?? 1 : 0, p.req.type === 'tv' ? p.req.episode ?? 1 : 0);
        if (alive()) p.segments = normalizeSkip(r);
      }
    } catch (_) { /* pas de segments : aucun bouton de saut */ }
  })();
  if (p.req.type === 'tv') loadSeasons().then(() => { if (alive()) ui.setSeries(true, !!nextRef()); });
}

async function loadSeasons() {
  if (!P || P.seasons.length) return;
  const m = appState.model && appState.model.key === P.req.key ? appState.model : null;
  let list = m && Array.isArray(m.seasons) ? m.seasons : null;
  if (!list) {
    try { const d = await tmdb('tv/' + P.req.id); list = d && d.seasons; } catch (_) { list = null; }
  }
  if (!P) return;
  P.seasons = (list || []).map((s) => ({ season: s.season_number, count: s.episode_count || 0 })).filter((s) => s.season > 0 && s.count > 0);
}

async function ensureEpisodes(season) {
  if (!P || P.req.type !== 'tv') return;
  await loadSeasons();
  const s = season ?? P.cur.season ?? 1;
  P.panelSeason = s;
  if (!P.episodes.has(s)) {
    P.episodesLoading = true;
    ui.refreshPanel();
    try {
      const d = await tmdb('tv/' + P.req.id + '/season/' + s);
      if (!P) return;
      P.episodes.set(s, (d.episodes || []).map((e) => ({ episode: e.episode_number, name: e.name, runtime: e.runtime, overview: e.overview || '', still: IMG('w300', e.still_path) })));
    } catch (_) { if (P) P.episodes.set(s, []); }
    if (P) P.episodesLoading = false;
  }
  ui.setHeading(...headingFor(P));
  updatePauseScreen();
  ui.refreshPanel();
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
  p.subs.selectedId = null;
  p.subs.cues = [];
  p.subs.native = false;
  p.subs.embedded = [];
  p.subs.loadedFor = null;
  p.subs.external = [];
  if (p.engine) { try { p.engine.destroy(); } catch (_) { /* ignoré */ } }
  ui.setError(null);
  const lx = { logo: p.meta.logo, source: sourceLine(view) };
  ui.setLoading(p.meta.title || 'Lecture', 'Préparation de la source…', lx);
  try {
    const shell = await connectShell();
    if (stale()) return;
    const media = await resolveMedia(view);
    if (stale()) return;
    p.mediaUrl = media.url;
    let probe = null;
    if (!shell && media.up) {
      ui.setLoading(p.meta.title || 'Lecture', media.torrent ? 'Connexion au torrent…' : 'Analyse du fichier…', lx);
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
    ui.setLoading(p.meta.title || 'Lecture', 'Moteur : ' + choice.label + '…', lx);
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
  const style = p.subs.style;
  const mem = getMemory(p.req.key);
  const idx = mem.sub ? pickRememberedSubtitle(subs, mem.sub) : pickDefaultSubtitle(subs, preferredLang(), audioLang, style.mode);
  if (idx >= 0) selectSubtitle(subs[idx].id, true);
  ensureExternalSubs(true);
}

async function ensureExternalSubs(auto) {
  const p = P;
  if (!p || p.subs.loadedFor === p.view.index || p.subs.loading) return;
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
    if (auto && p.subs.selectedId === null && p.defaultsDone) {
      const mem = getMemory(p.req.key);
      const idx = mem.sub ? pickRememberedSubtitle(allSubtitleTracks(), mem.sub) : pickDefaultSubtitle(allSubtitleTracks(), preferredLang(), p.audioLang || '', p.subs.style.mode);
      if (idx >= 0) selectSubtitle(allSubtitleTracks()[idx].id, true);
    }
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
  s.native = false;
  if (!id) {
    p.engine.setSubtitleTrack(null);
    if (!quiet) ui.toast('Sous-titres désactivés');
    ui.refreshPanel();
    return;
  }
  const track = allSubtitleTracks().find((t) => t.id === id);
  if (!track) return;
  if (track.origin === 'embedded' && !track.url) {
    p.engine.setSubtitleTrack(track.id);
    s.native = true; // mpv les affiche lui-même ; hls.js : cues relues dans le calque
  } else {
    p.engine.setSubtitleTrack(null);
    try {
      const up = await serverAlive();
      const base = serverBase();
      const via = up && track.origin === 'external' ? subtitlesVttUrl(base, track.url) : track.url;
      let text = '';
      try { text = await (await fetch(via)).text(); } catch (_) { text = await (await fetch(track.url)).text(); }
      if (P === p && s.selectedId === id) s.cues = parseSubtitles(text, track.url);
      if (P === p && !s.cues.length && s.selectedId === id) ui.toast('Ce sous-titre est vide ou illisible');
    } catch (_) {
      if (P === p) ui.toast('Impossible de charger ce sous-titre');
    }
  }
  if (!quiet) ui.toast('Sous-titres : ' + track.label);
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
  if (!p || !p.engine) return;
  const st = p.engine.state();
  tickN += 1;
  // Sous-titres (100 ms).
  const s = p.subs;
  let cues = s.cues;
  if (s.native && p.engine.kind === 'html') {
    if (tickN % 5 === 0) s.nativeCues = p.engine.nativeCues();
    cues = s.nativeCues || [];
  }
  const cue = s.native && p.engine.kind === 'mpv' ? null : activeCue(cues, st.time, s.offset);
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
  if (st.duration > 0) {
    const seg = activeSkip(p.segments, st.time);
    if (seg && autoSkipEnabled(seg.kind) && p.skipped !== seg.start && p.undone !== seg.start) {
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
  if (!P || !P.engine) return;
  const s = st || P.engine.state();
  ui.update(s, chapterMarks(P.segments, s.duration));
}

// ---------- Progression ----------

function saveProgress(force, st) {
  const p = P;
  if (!p || !p.engine) return;
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
  if (!P) return;
  P.engine.seek(t);
  P.watch.reset(Date.now());
  P.skipped = null;
}

function seekBy(d) {
  if (!P) return;
  const st = P.engine.state();
  seekTo(Math.min(st.duration || Infinity, Math.max(0, st.time + d)));
  ui.toast((d > 0 ? '+' : '−') + Math.abs(d) + ' s', 900);
}

function togglePlay() {
  if (!P) return;
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
  if (!P || !P.engine.supportsPip()) { ui.toast('Image dans l’image indisponible ici'); return; }
  try { await P.engine.togglePip(); } catch (_) { ui.toast('Image dans l’image refusée par le navigateur'); }
}

function openChangeSource() {
  if (!P) return;
  const p = P;
  const btn = ui.root.querySelector('[data-act="source"]');
  openSourcePicker(p.req, btn, {
    views: p.views, currentIndex: p.view.index,
    onPick: (view) => {
      if (!P || P.token !== p.token) return;
      const st = P.engine.state();
      if (view.index === P.view.index) { ui.focusFirst(); return; }
      P.attempts = 0;
      P.tried = new Set();
      ui.toast('Changement de source…');
      playView(view, st.time > 5 ? st.time : 0);
      ui.focusFirst();
    },
  });
}

async function playEpisode(season, episode) {
  const p = P;
  if (!p) return;
  const req = { ...p.req, season, episode, imdb: p.imdb };
  ui.closePanel(true);
  ui.setLoading(p.meta.title, 'Recherche d’une source pour S' + season + ' · É' + episode + '…');
  try {
    const { views } = await loadSources(req);
    if (!P || P.token !== p.token) return;
    const bw = await measureBandwidthKbps().catch(() => null);
    const rec = recommendFor(views, bw);
    if (!rec) { ui.setLoading(null); ui.toast('Aucune source pour cet épisode', 5000); return; }
    const opener = p.opener;
    await startSession(req, views, rec.view, { opener, resume: 'none', notice: rec.languageFallback ? rec.reason : '' });
  } catch (_) {
    ui.setLoading(null);
    ui.toast('Impossible de charger les sources de cet épisode', 5000);
  }
}

function onAction(act, data) {
  if (!P) return;
  const st = P.engine.state();
  switch (act) {
    case 'close': closePlayer(); break;
    case 'toggle-play': togglePlay(); break;
    case 'back10': seekBy(-10); break;
    case 'fwd10': seekBy(10); break;
    case 'mute': P.engine.setMuted(!st.muted); break;
    case 'fullscreen': toggleFullscreen(); break;
    case 'pip': togglePip(); break;
    case 'info': ui.togglePanel('info'); break;
    case 'source': openChangeSource(); break;
    case 'skip': { const seg = activeSkip(P.segments, st.time); if (seg) { seekTo(seg.end); ui.toast('Passé'); } break; }
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
    case 'audio': { const t = P.engine.audioTracks().find((x) => x.id === data.id); if (t && t.lang) remember(P.req.key, { audio: t.lang }); P.engine.setAudioTrack(data.id); } P.watch.reset(Date.now()); setTimeout(() => ui.refreshPanel(), 200); ui.toast('Audio : ' + ((P.engine.audioTracks().find((t) => t.id === data.id) || {}).label || '')); break;
    case 'force-hls': P.forceHls = true; ui.closePanel(true); ui.toast('Passage en transcodage…'); P.tried = new Set(); playView(P.view, st.time > 5 ? st.time : 0); break;
    case 'sub': {
      const t = data.id ? allSubtitleTracks().find((x) => x.id === data.id) : null;
      remember(P.req.key, { sub: t ? t.lang || 'off' : 'off' });
      selectSubtitle(data.id || null);
      break;
    }
    case 'suboffset': P.subs.offset = stepOffset(P.subs.offset, Number(data.by)); ui.refreshPanel(); break;
    case 'substyle': updateStyle({ [data.key]: data.val }); break;
    case 'substep': { const cur = P.subs.style; updateStyle({ [data.key]: cur[data.key] + Number(data.by) }); break; }
    case 'rate': P.engine.setRate(Number(data.rate)); setTimeout(() => ui.refreshPanel(), 50); break;
    case 'autopip': { const on = storeGet(AUTOPIP_KEY) !== '1'; storeSet(AUTOPIP_KEY, on ? '1' : '0'); ui.video.autoPictureInPicture = on; ui.refreshPanel(); break; }
    case 'season': ensureEpisodes(Number(data.season)); break;
    case 'episode': playEpisode(Number(data.season), Number(data.episode)); break;
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
  if (!p) return {};
  if (name === 'tracks') {
    const tracks = p.engine.audioTracks();
    const hasApi = p.engine.kind !== 'html' || !!ui.video.audioTracks || !!p.engine.hls;
    return {
      audio: {
        tracks,
        note: hasApi ? 'Une seule piste audio dans ce flux.' : 'Ce navigateur n’expose pas les pistes audio d’un fichier lu directement.',
        canTranscode: !tracks.length && !hasApi && p.choice && p.choice.engine === 'direct',
      },
      subs: { tracks: allSubtitleTracks(), selectedId: p.subs.selectedId, offset: p.subs.offset, style: p.subs.style, loading: p.subs.loading },
    };
  }
  if (name === 'speed') return { rate: p.engine.state().rate, autoPip: storeGet(AUTOPIP_KEY) === '1', pipAvailable: p.engine.supportsPip() };
  if (name === 'episodes') {
    const s = p.panelSeason ?? p.cur.season ?? 1;
    const episodes = (p.episodes.get(s) || []).map((e) => {
      const pr = userStore.getProgress(p.req.key, s, e.episode);
      return { ...e, watched: userStore.isWatched(p.req.key, s, e.episode), progress: pr && pr.duration ? pr.position / pr.duration : 0 };
    });
    return { seasons: p.seasons, season: s, episodes, loading: !!p.episodesLoading, current: p.cur };
  }
  if (name === 'info') {
    const v = p.view;
    const rows = [
      ['Titre', p.meta.title + (p.req.season != null ? ' · ' + seLabel(p.req) : '')],
      ['Moteur', p.choice ? p.choice.label : '…'],
      ['Qualité', [v.quality, v.sourceType, v.codec, ...v.hdr].filter(Boolean).join(' · ')],
      ['Audio', v.audio || 'Inconnu'],
      ['Langues', v.langs.map((l) => l.label + (l.verified ? ' ✓' : '')).join(', ') || 'Inconnues'],
      ['Taille', [v.sizeLabel, v.bitrateLabel, v.durationLabel && '≈ ' + v.durationLabel].filter(Boolean).join(' · ') || 'Inconnue'],
      ['Statut', v.statusLabel],
      ['Fichier', v.filename || '—'],
    ];
    if (v.releaseGroup) rows.push(['Release', v.releaseGroup]);
    if (p.probeTracks.height) rows.push(['Vidéo', p.probeTracks.width + '×' + p.probeTracks.height + ' · ' + (p.probeTracks.videoCodec || '').toUpperCase()]);
    if (p.choice) rows.push(['Pourquoi ce moteur', p.choice.reason]);
    rows.push(['Serveur de streaming', serverBase()]);
    return { rows };
  }
  return {};
}

// ---------- Clavier ----------

function onKey(e) {
  if (!P || ui.root.hidden) return;
  const modal = document.getElementById('modal');
  if (modal && !modal.hidden) return; // le sélecteur de sources gère ses propres touches
  const t = e.target instanceof Element ? e.target : null;
  const typing = !!(t && t.closest('input[type="text"], textarea, select'));
  const onButton = !!(t && t.closest('button'));
  const action = keyToAction(e.key, { panelOpen: !!ui.panel, typing, onButton }, { ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey });
  ui.wake();
  if (!action) return;
  if (action.type === 'wake') return;
  if (action.type === 'nav') { e.preventDefault(); e.stopImmediatePropagation(); ui.navPanel(action.dir); return; }
  e.preventDefault();
  e.stopImmediatePropagation();
  const st = P.engine.state();
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
 * Choisit la meilleure source selon le débit et la langue préférée et la lance sans passer par le sélecteur.
 * Réglage « lecture automatique » désactivé, ou aucune source qui tienne : ouvre le sélecteur.
 */
export async function playBest(request, opener, opts = {}) {
  ensureUI();
  appToast('Recherche de la meilleure source…', { ms: 4000 });
  const pick = (view, views) => startSession(request, views || loaded.views, view, { opener, resume: opts.resume || 'ask', notice: '' });
  let loaded;
  try {
    if (userStore.loadProgress) await userStore.loadProgress(request.key);
    loaded = await loadSources(request);
  } catch (_) { loaded = null; }
  // Rien de lisible ou erreur : le sélecteur explique pourquoi (aucune source, lastAddon injoignable…).
  if (!loaded || !loaded.views.length) { openSourcePicker(request, opener, { onPick: pick }); return; }
  request.imdb = loaded.imdb;
  if (!getAutoplay() && !opts.force) {
    openSourcePicker(request, opener, { views: loaded.views, onPick: pick });
    return;
  }
  const bw = await measureBandwidthKbps().catch(() => null);
  const rec = recommendFor(loaded.views, bw);
  if (!rec) { openSourcePicker(request, opener, { views: loaded.views, onPick: pick }); return; }
  await startSession(request, loaded.views, rec.view, { opener, resume: opts.resume || 'ask', notice: rec.languageFallback ? rec.reason : '' });
}

/** Lance une source choisie dans le sélecteur. */
export function playSource(request, views, view, opener, opts = {}) {
  return startSession(request, views, view, { opener, resume: opts.resume || 'ask' });
}

export { formatClock };
