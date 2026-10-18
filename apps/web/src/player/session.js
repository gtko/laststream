/* Session de lecture : s'ouvre tout de suite (écran de chargement), cherche et choisit la source à l'intérieur du lecteur,
 * choisit le moteur, suit la progression, saute les génériques, bascule sur une autre copie en cas d'échec, gère pistes
 * audio, sous-titres (calage compris), épisodes. L'interface est dans ui.js et panels.js. */
import { addonUrl, getBase, isConfigured } from '../data/config';
import { streamingServerFor } from '../data/lan';
import { api, postLt, skipSegments, tmdb, ltHealth } from '../data/lt';
import { ltUrl } from '../data/config';
import { pushPrefs } from '../data/auth';
import { getLangPrefs, setLangPrefs, wantedSubLang } from '../data/langPrefs';
import { getAutoplay, getSkipPref, getVideoLang } from '../data/prefs';
import { episodeStreamId, imdbIdOf, measureBandwidthKbps } from '../data/sources';
import { userStore } from '../data/userStore';
import { POLL_EVERY_MS, POLL_MAX_MS, loadSources, pollSources, preferredLang, recommendFor } from '../sources/load';
import { describePending, isGoodMatch } from '../sources/rank';
import { openSourcePicker } from '../sources/picker.js';
import { IMG } from '../ui/constants.js';
import { showRatePrompt } from '../ui/rate.js';
import { state as appState } from '../ui/state.js';
import { clientCopiesOf, isClientStream, originSummary } from '../sources/info';
import { createLevelProbe, levelProbeSupported } from './audiolevel.js';
import { browserCaps } from './caps';
import { CONVERSION_LABEL, chooseEngine, directVideoOk, probeConversion } from './engine';
import { HtmlEngine, MpvEngine, NativeEngine } from './engines.js';
import { autoNextEpisode, filterEpisodes, firstUnseen, isAired, isPlayable, normalizeCanonical } from './episodes';
import { fetchExternalSubtitles } from './extsubs';
import { autoSubsToast } from './langPolicy';
import { TrackApplier } from './trackApply';
import { StallWatch, failoverOrder, pickRaceCandidate } from './failover';
import { raceCandidates } from './race';
import { keyToAction, stepVolume } from './keys';
import { MiniState, minimizeExits } from './mini';
import { badSources, fileKey, getMemory, getSubSync, markBad, remember, setSubSync, sourceKey } from './memory';
import { formatClock, isWatched, nextEpisode, resumeDecision, shouldSave } from './progress';
import { NativePlayer, isNativePlayer, toNativeEpisodes, toNativeSegments, toNativeSources, toNativeSubtitles } from './native';
import { backStep, connectShell, setShellFullscreen, setShellPip, startShellDrag } from './shell';
import { activeSkip, analyzeUrl, autoSkipEnabled, buildSubmission, chapterMarks, movieEndRow, nextEpisodeCard, normalizeSkip, shouldRepoll, validAnalyzeDuration } from './skip';
import {
  embeddedSubtitleUrl, fetchOpenSubParams, fetchProbe, hlsMasterUrl, hlsQuery, newSessionId, proxyUrl,
  SERVER_STORAGE_KEY as SERVER_KEY, serverAlive, serverBase, setShellServerAddress, subtitlesVttUrl,
} from './server';
import { activeCue, cueHtml, normalizeSubStyle, parseSubtitles, readSubStyle, writeSubStyle } from './subs';
import { RATE_CHOICES, findSync, rateChoice, suggestRate, syncTrusted } from './subsync';
import { langFromTitle, normalizeLang, parseProbe } from './tracks';
import { groupAudioTracks, sectionSubtitleTracks } from './trackgroups';
import { nextPhase, shouldBeReady } from './phase';
import { Thumbs } from './thumbview.js';
import { thumbsAllowed, thumbSource } from './thumbs';
import { ThumbFeed, serverHasThumbs } from './thumbfeed';
import { debrid, PROVIDER_LABEL } from '../sources/debridClient';
import { createRangeFetch, parseDebridUrl } from '../sources/debrid/http';
import { makeLocalFeed, webCodecsAvailable, IdbThumbStore } from '../thumbs';
import { createPlayerUI } from './ui.js';
import { partyBridge } from '../party/bridge';
import { setWatching } from '../data/presence';
import { mountPartyPanel, togglePartyPanel } from '../ui/partypanel.js';
import { knownBandwidthKbps } from '../sources/load';

const AUTOPIP_KEY = 'laststream.player.autopip';
const THUMBS_KEY = 'laststream.player.thumbs';
const MAX_ATTEMPTS = 6;
const AUTOSYNC_TARGET = 90;
const AUTOSYNC_MIN = 25;

let ui = null;
let thumbs = null;
/** Aperçu mpv : images ffmpeg de lastAddon (une par 30 s) ; `addonThumbs` = capacité annoncée par le serveur. */
let feed = null;
let addonThumbs = false;
/** Aperçu par plages (src/thumbs) : relais Cloudflare + WebCodecs, pour les liens débridés distants. */
let rangeFeed = null;
let rangeLocal = null;
let rangeStore = null;
let html = null;
let mpv = null;
let nativeEng = null;
let P = null; // session courante (null : lecteur fermé)
let tickTimer = null;
let shell = null; // transport de la coque Windows (null dans un navigateur)
let shellFullscreen = false;
let shellPip = false; // image dans l'image de la coque (petite fenêtre au premier plan)
let nativeMini = false; // vignette flottante du lecteur natif Android affichée (la page web est alors libre)
let lastMiniRect = null; // rectangle de l'image du mini-lecteur (px de la fenêtre), pour mpv

const storeGet = (k) => { try { return globalThis.localStorage.getItem(k); } catch (_) { return null; } };
const storeSet = (k, v) => { try { globalThis.localStorage.setItem(k, v); } catch (_) { /* ignoré */ } };
const getCaps = browserCaps;
const miniState = new MiniState({
  getItem: (k) => storeGet(k),
  setItem: (k, v) => storeSet(k, v),
});

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

const sourceLine = (v) => [v.quality, v.langs.map((l) => l.label).join('/'), v.provider, originSummary(v.origins, 1)].filter(Boolean).join(' · ');

// ---------- Création de l'interface (une seule fois) ----------
function thumbSourceOf(p) {
  return thumbSource({ engine: p && p.choice ? p.choice.engine : null, hasMedia: !!(p && p.mediaUrl), serverUp: !!(p && p.mediaUp), forceHls: !!(p && p.forceHls), addon: addonThumbs, range: rangeUrlOf(p) !== null && webCodecsAvailable() });
}

/** Adresse de la source pour lastAddon : serveur de streaming local (repris derrière le relais /_ss) ou lien http(s) émis par lui. */
function thumbMediaUrl(p) {
  const u = p && p.mediaUrl;
  if (!u) return null;
  return analyzeUrl(u, serverBase()) || (/^https?:/i.test(u) ? u : null);
}

/** Lien https d'un hébergeur débridé (AllDebrid, TorBox, Real-Debrid) : lu directement depuis l'appareil, sinon null. */
function rangeUrlOf(p) {
  const u = thumbMediaUrl(p);
  return u && parseDebridUrl(u) ? u : null;
}

/** Lecture de plages des miniatures : navigateur, puis pont natif (Windows, Android) ; jamais par un serveur. */
const rangeHttp = createRangeFetch();

function thumbsAllowedNow() {
  return !!P && !!P.view && thumbsAllowed({
    enabled: storeGet(THUMBS_KEY) !== '0', hasSource: thumbSourceOf(P).mode !== 'none', duration: P.engine.state().duration,
    bandwidthKbps: knownBandwidthKbps(), torrentBuffering: false,
  });
}

/** Survol de la barre avec mpv : image ffmpeg de la tranche de 30 s la plus proche, affichée dès qu'elle est prête, sinon rien. */
function addonThumb(t) {
  const img = ui.thumbImg;
  if (!thumbsAllowedNow()) { img.hidden = true; return; }
  if (!feed) {
    feed = new ThumbFeed({
      register: async () => {
        const url = thumbMediaUrl(P);
        if (!url || !P) return null;
        const st = P.engine.state();
        const r = await postLt('thumbs', { url, duration: Math.round(st.duration), start: Math.round(st.time) });
        return r && typeof r.key === 'string' ? r.key : null;
      },
      imageUrl: (key, index) => ltUrl('thumbs/' + key + '/' + index + '.webp'),
      fetchFn: (url, init) => fetch(url, init),
      makeUrl: (blob) => URL.createObjectURL(blob),
      revokeUrl: (url) => { try { URL.revokeObjectURL(url); } catch (_) { /* ignoré */ } },
      wait: (ms, signal) => new Promise((resolve) => { const id = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(id); resolve(); }, { once: true }); }),
      onReady: (index, url) => { if (feed && feed.targetIndex === index) { img.src = url; img.hidden = false; } },
    });
  }
  const url = feed.request(t, P.engine.state().duration);
  if (url) { img.src = url; img.hidden = false; } else img.hidden = true;
}

/** Survol de la barre, voie par plages : image clé lue directement chez l'hébergeur débridé (même IP que la lecture) puis décodée ici (WebCodecs). */
function rangeThumb(t) {
  const img = ui.thumbImg;
  if (!thumbsAllowedNow()) { img.hidden = true; return; }
  if (!rangeFeed) {
    rangeStore = new IdbThumbStore();
    rangeFeed = new ThumbFeed({
      register: async (signal) => {
        const sourceId = rangeUrlOf(P);
        if (!sourceId) return null;
        rangeLocal = makeLocalFeed({
          sourceId, store: rangeStore, fetchFn: rangeHttp,
          resolve: async () => ({ url: sourceId }),
        });
        return rangeLocal.register(signal);
      },
      imageUrl: (key, index) => rangeLocal.imageUrl(key, index),
      fetchFn: (url, init) => rangeLocal.fetchFn(url, init),
      maxParallel: 2,
      makeUrl: (blob) => URL.createObjectURL(blob),
      revokeUrl: (url) => { try { URL.revokeObjectURL(url); } catch (_) { /* ignoré */ } },
      wait: (ms, signal) => new Promise((resolve) => { const id = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(id); resolve(); }, { once: true }); }),
      onReady: (index, url) => { if (rangeFeed && rangeFeed.targetIndex === index) { img.src = url; img.hidden = false; } },
    });
  }
  const url = rangeFeed.request(t, P.engine.state().duration);
  if (url) { img.src = url; img.hidden = false; } else img.hidden = true;
}

function cancelAddonThumb() {
  if (rangeFeed) rangeFeed.cancel();
  if (feed) feed.cancel();
  if (ui && ui.thumbImg) ui.thumbImg.hidden = true;
}

/** La capacité « miniatures » est annoncée par /lt/health (ffmpeg présent côté lastAddon) ; l'option est masquée sinon. */
function refreshAddonThumbs() {
  if (addonThumbs) return;
  ltHealth().then((h) => { addonThumbs = serverHasThumbs(h); if (ui) ui.refreshPanel(); }).catch(() => undefined);
}

/** Titre en cours de lecture, tel que le salon (watch party) le voit : identité, source choisie, moteur. Jamais de lien. */
function partyAdapter(p = P) {
  if (!p) return null;
  return {
    req: p.req, cur: p.cur, view: p.view, poster: p.meta ? p.meta.poster : '', engine: p.engine,
    ready: !!(p.view && p.engine && p.mediaUrl && !p.failing && !p.resumeTimer),
  };
}

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
    thumb: (t) => {
      if (!P || !P.view) return;
      const mode = thumbSourceOf(P).mode;
      if (mode === 'range') rangeThumb(t);
      else if (mode === 'addon') addonThumb(t);
      else if (thumbs) thumbs.request(t);
    },
    thumbCancel: () => { if (thumbs) thumbs.cancel(); cancelAddonThumb(); },
    miniState,
    miniLayout: onMiniLayout,
  });
  miniState.onChange(applyMini);
  // Bascule automatique entre débrideurs : « AllDebrid indisponible → TorBox ».
  debrid().setHandlers({ onSwitch: (from, to) => ui.toast(PROVIDER_LABEL[from] + ' indisponible → ' + PROVIDER_LABEL[to], 6000) });
  mountPartyPanel(ui.root, { adapter: () => partyAdapter() });
  thumbs = new Thumbs(ui.thumbCanvas, {
    allowed: () => thumbsAllowedNow(),
    duration: () => (P ? P.engine.state().duration : 0),
    // Vidéo d'aperçu : lien direct, ou seconde session HLS basse résolution du serveur (jamais celle de la lecture).
    source: async () => {
      const p = P;
      const src = thumbSourceOf(p);
      if (src.mode === 'direct') return { url: p.mediaUrl, hls: false };
      if (src.mode === 'hls') return { url: hlsMasterUrl(p.mediaBase || serverBase(), newSessionId(), p.mediaUrl, getCaps(), src.forceTranscoding, src.maxWidth), hls: true };
      return null;
    },
  });
  html = new HtmlEngine(ui.video);
  bindEngine(html);
  bindShell();
  const v = Number(storeGet('laststream.player.volume'));
  if (Number.isFinite(v) && storeGet('laststream.player.volume') !== null) ui.video.volume = Math.min(1, Math.max(0, v));
  ui.video.autoPictureInPicture = storeGet(AUTOPIP_KEY) === '1';
  ui.setPipAvailable(html.supportsPip());
  document.addEventListener('keydown', onKey, true);
  // Image dans l'image : pas de barre de titre, on déplace la fenêtre en glissant sur la vidéo (hors boutons et barre de lecture).
  ui.root.addEventListener('mousedown', (e) => {
    if (!shell || !shellPip || e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest('button, input, [data-seek]')) return;
    e.preventDefault();
    startShellDrag(shell);
  }, true);
  document.addEventListener('fullscreenchange', () => { if (P) refreshUI(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && P) saveProgress(true); });
  window.addEventListener('pagehide', () => { if (P) saveProgress(true); });
  // Retour du navigateur pendant la lecture : le lecteur se réduit (la page derrière a déjà navigué) au lieu de se fermer.
  window.addEventListener('popstate', () => { if (P && P.view && !miniState.mini) minimizePlayer(); });
}

// ---------- Mini-lecteur ----------

/** Réduction possible : une source est en lecture, moteur web ou mpv (le lecteur natif Android a son image dans l'image système). */
const canMinimize = () => !!P && !!P.view && !!P.engine && !(shell && shellPip);

function minimizePlayer() {
  if (!canMinimize()) return false;
  // Plein écran (document ou fenêtre de la coque) quitté d'abord : la vignette serait sinon perdue dans l'écran.
  const exits = minimizeExits({ docFullscreen: !!document.fullscreenElement, shell: !!shell, shellFullscreen });
  if (exits.exitDoc) document.exitFullscreen().catch(() => {});
  if (exits.exitShell) { shellFullscreen = false; setShellFullscreen(shell, false); }
  saveProgress(true);
  const native = P.engine.kind === 'native';
  const ok = miniState.minimize();
  // Lecteur natif Android : la vignette est une vue native ; si elle n'est pas disponible (télévision), on revient au plein écran.
  if (ok && native) P.engine.minimize().then((on) => { if (!on && nativeMini) { nativeMini = false; miniState.expand(); } });
  return ok;
}

function expandPlayer() {
  if (nativeMini && nativeEng) nativeEng.expand();
  return miniState.expand();
}

/** Remise à zéro du mini-lecteur à chaque nouvelle session ; la vignette native, elle, accueille le média suivant sans repasser en plein écran. */
function resetMini() {
  if (nativeMini) return;
  miniState.reset();
}

/** Nouvelle position de la vignette : mpv recale son image (marges) et la page est percée au même endroit. */
function onMiniLayout(video) {
  lastMiniRect = video;
  if (mpv) mpv.setMini(video);
}

/** Bascule visuelle réduit / plein lecteur (la lecture, elle, n'est jamais interrompue). */
function applyMini(on) {
  if (!ui) return;
  nativeMini = on && !!P && !!P.engine && P.engine.kind === 'native';
  ui.root.classList.toggle('is-native-mini', nativeMini);
  ui.setMini(on);
  document.body.classList.toggle('modal-open', !on && !!P);
  if (on) {
    const a = document.activeElement;
    if (a instanceof HTMLElement && ui.root.contains(a)) a.blur();
    const opener = P && P.opener;
    if (opener && opener.isConnected && opener.focus) opener.focus({ preventScroll: true });
  } else {
    if (mpv) mpv.setMini(null);
    lastMiniRect = null;
    if (P) { ui.wake(); ui.focusFirst(); }
  }
}

/** Événements de la coque : touches multimédia (lecture/pause, piste suivante) et état plein écran de la fenêtre. */
function bindShell() {
  connectShell().then((t) => {
    if (!t) return;
    shell = t;
    t.on('media-key', (action) => {
      if (!P || !P.view) return;
      if (action === 'play-pause') togglePlay();
      else if (action === 'next-track') onAction('next');
      else if (action === 'previous-track') seekTo(0);
    });
    t.on('win-visibility-changed', (v) => { if (v && typeof v.isFullscreen === 'boolean') { shellFullscreen = v.isFullscreen; if (P) refreshUI(); } });
    t.on('win-pip-changed', (v) => {
      if (!v || typeof v.pip !== 'boolean') return;
      shellPip = v.pip;
      if (shellPip) shellFullscreen = false;
      if (ui) ui.root.classList.toggle('is-pip', shellPip);
      if (P) refreshUI();
    });
    t.on('win-set-visibility', (v) => { if (v && typeof v.fullscreen === 'boolean') { shellFullscreen = v.fullscreen; if (P) refreshUI(); } });
  });
}

const rememberVolume = (v) => storeSet('laststream.player.volume', String(v));

function bindEngine(e) {
  e.on('state', () => { if (P && P.engine === e) refreshUI(); });
  e.on('ended', () => { if (P && P.engine === e) onEnded(); });
  e.on('error', (err) => { if (P && P.engine === e) failover('Erreur de lecture (' + (err && err.message ? err.message : 'inconnue') + ')'); });
  e.on('tracks', () => { if (P && P.engine === e) onTracks(); });
  e.on('ready', () => { if (P && P.engine === e) onReady(); });
  // Lecteur natif Android : fermeture par l'utilisateur, bouton « Épisode suivant », changement de piste dans le panneau natif.
  e.on('closed', () => { if (P && P.engine === e) closePlayer(); });
  e.on('next', () => { if (P && P.engine === e) onAction('next'); });
  e.on('trackChanged', (d) => { if (P && P.engine === e) onNativeTrack(d); });
  // Vignette native : réduite ou agrandie depuis le natif (tap, bouton retour, geste), l'état web suit.
  e.on('mini', (on) => { if (P && P.engine === e) { if (on) miniState.minimize(); else { nativeMini = false; miniState.expand(); } } });
  e.on('selectSource', (d) => { if (P && P.engine === e) onNativeSource(d); });
  e.on('selectEpisode', (d) => { if (P && P.engine === e) playEpisode(Number(d.season), Number(d.episode)); });
  e.on('loadSeason', (d) => { if (P && P.engine === e) ensureEpisodes(Number(d.season)).then(syncNative); });
}

/** Choix de piste fait dans le panneau du lecteur natif : mémorisé par titre, comme dans le lecteur web. */
function onNativeTrack(d) {
  if (!P || !d) return;
  // Les pistes que nous venons d'appliquer (ou celles que le lecteur choisit seul au départ) ne sont pas un choix de l'utilisateur.
  if (!P.applier.done || Date.now() - P.autoAppliedAt < 2500) return;
  P.applier.markManual();
  if (d.kind === 'audio' && d.lang) remember(P.req.key, { audio: d.lang });
  if (d.kind === 'sub') remember(P.req.key, { sub: d.lang && d.lang !== 'off' ? d.lang : 'off' });
}

/** Source choisie dans le panneau natif : même bascule que le sélecteur web, à la position courante. */
function onNativeSource(d) {
  const p = P;
  if (!p || !d) return;
  const v = p.views.find((x) => String(x.index) === String(d.id));
  if (!v) return;
  if (p.view && v.index === p.view.index) return;
  p.attempts = 0;
  p.tried = new Set();
  playView(v, Number(d.position) > 5 ? Number(d.position) : 0);
}

/** Listes des panneaux « Sources » et « Épisodes » du lecteur natif, tirées de la session. */
function nativeLists() {
  const p = P;
  const sources = toNativeSources(p.views, p.view ? p.view.index : null, (v) => sourceLine(v) + (v.status === 'cached' ? ' ⚡' : ''), (v) => originSummary(v.origins, 2));
  const episodes = p.req.type === 'tv' && p.cur.season != null
    ? toNativeEpisodes(p.seasons, p.episodes, p.cur, (sn, ep) => {
      const pr = userStore.getProgress(p.req.key, sn, ep);
      return { watched: userStore.isWatched(p.req.key, sn, ep), progress: pr && pr.duration ? pr.position / pr.duration : 0 };
    })
    : null;
  return { sources, episodes };
}

/** Sources trouvées après le démarrage : le panneau natif se complète. */
async function pollMoreSources(p) {
  const token = p.token;
  let cur = p.loaded;
  for (let i = 0; cur && cur.pending && cur.pending.length && i < 8; i += 1) {
    await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
    if (!P || P.token !== token) return;
    const next = await pollSources(p.req, cur).catch(() => cur);
    if (!P || P.token !== token) return;
    if (next !== cur) {
      cur = next;
      p.views = next.views;
      p.pending = next.pending;
      p.ranked = [...next.views];
      syncNative();
    }
  }
}

/** Options d'ouverture du lecteur natif : titre, reprise, langues, segments de saut et épisode suivant. */
function nativeOptions() {
  const p = P;
  const mem = getMemory(p.req.key);
  const nx = nextRef();
  const info = nx && (p.episodes.get(nx.season) || []).find((e) => e.episode === nx.episode);
  return {
    title: headingFor(p)[0],
    subtitle: headingFor(p)[1],
    preferredAudioLang: audioPreference()[0] || '',
    preferredSubLang: mem.sub || wantedSubLang(getLangPrefs()) || '',
    subMode: mem.sub ? 'always' : effectiveSubMode(),
    skipSegments: toNativeSegments(p.segments),
    ...nativeLists(),
    nextEpisode: nx ? { title: 'S' + nx.season + ':É' + nx.episode + (info && info.name ? ' « ' + info.name + ' »' : ''), still: (info && info.still) || '' } : null,
  };
}

/** Pousse au lecteur natif ce qui arrive après l'ouverture (segments, épisode suivant, titre). */
function syncNative() {
  const p = P;
  if (!p || !p.engine || p.engine.kind !== 'native') return;
  const o = nativeOptions();
  p.engine.update({ skipSegments: o.skipSegments, nextEpisode: o.nextEpisode, title: o.title, subtitle: o.subtitle, sources: o.sources, episodes: o.episodes });
}

// ---------- Ouverture ----------

/** Crée la session et ouvre le lecteur tout de suite, sans source : l'écran de chargement prend le relais. */
async function initSession(request, views, view, opts = {}) {
  ensureUI();
  resetMini();
  if (P) await teardown(true);
  const token = Symbol('session');
  P = {
    token, req: request, views, ranked: [...views], cur: { season: request.season, episode: request.episode },
    view, tried: new Set(), attempts: 0, engine: html, choice: null, probe: null, probeTracks: parseProbe(null), mediaUrl: '',
    segments: [], nextDismissed: false, lastSave: 0, watchedMarked: false, finished: false,
    subs: {
      external: [], loadedFor: null, loading: false, selectedId: null, secondaryId: null, cues2: [], native2: false, shift2: 0, swapped: false, cues: [], offset: 0, rate: 1, rateId: 'none', shift: 0, rateHint: '',
      style: readSubStyle(), native: false, nativeCues: [], styleOpen: false, sync: { state: 'idle', message: '' }, syncKey: '',
    },
    defaultsDone: false, applier: new TrackApplier(), autoToast: false, autoAppliedAt: 0, seasons: [], episodes: new Map(), opener: opts.opener || document.activeElement, failing: false,
    notice: opts.notice || '', forceHls: false, startedAt: 0, resumeTimer: null, imdb: request.imdb || '', epQuery: '', canonical: false,
    mark: { state: 'idle', kind: 'intro', start: 0 }, aspect: 'contain',
    skipPoll: { analyzing: false, polls: 0, lastAt: 0 }, analyzed: false,
  };
  const meta = appState.byKey.get(request.key) || {};
  const model = appState.model && appState.model.key === request.key ? appState.model : null;
  P.model = model;
  P.meta = {
    poster: meta.posterPath || (model && model.posterPath) || '', backdrop: meta.backdropPath || (model && model.backdropPath) || '', title: request.name || meta.name || '',
    logo: (model && model.logo) || '', overview: (model && model.overview) || meta.overview || '',
  };
  document.body.classList.add('modal-open', 'lp-open');
  P.phase = nextPhase('ready', 'open');
  ui.setPhase(P.phase);
  ui.root.classList.toggle('is-searching', !view);
  ui.root.classList.remove('is-mpv', 'is-video');
  ui.setMiniAvailable(true);
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
  ui.setPartyAvailable(partyBridge.available());
  if (request.id && Number.isFinite(Number(request.id))) {
    setWatching({ type: request.type === 'tv' ? 'series' : 'movie', tmdbId: Number(request.id), title: request.name || '', ...(request.type === 'tv' && request.season != null ? { season: request.season, episode: request.episode } : {}) });
  }
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
        if (alive()) {
          p.segments = normalizeSkip(r);
          syncNative();
          p.skipPoll = { analyzing: !!r && r.analyzing === true, polls: 0, lastAt: Date.now() };
        }
      }
    } catch (_) { /* pas de segments : aucun bouton de saut */ }
  })();
  if (p.req.type === 'tv') loadSeasons().then(() => { if (alive()) { ui.setSeries(true, !!nextRef()); syncNative(); } });
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
  // « Chargement… » dès l'ouverture, y compris pendant la liste canonique des saisons.
  if (!p.seasons.length) { p.episodesLoading = true; p.episodesError = false; ui.refreshPanel(); }
  await loadSeasons();
  if (P !== p) return;
  const s = season ?? p.cur.season ?? 1;
  p.panelSeason = s;
  if (!p.episodes.has(s)) {
    p.episodesLoading = true;
    p.episodesError = false;
    ui.refreshPanel();
    try {
      const d = await tmdb('tv/' + p.req.id + '/season/' + s);
      if (P !== p) return;
      const today = new Date().toISOString().slice(0, 10);
      p.episodes.set(s, (d.episodes || []).map((e) => ({
        episode: e.episode_number, name: e.name || '', runtime: e.runtime || null, overview: e.overview || '', still: IMG('w300', e.still_path),
        airDate: e.air_date || '', aired: isAired(e.air_date || '', today), playable: isPlayable(e.air_date || '', today),
      })));
    } catch (_) { if (P === p) p.episodesError = true; } // pas mis en cache : rouvrir le panneau réessaie
    if (P === p) p.episodesLoading = false;
  } else p.episodesLoading = false;
  if (P !== p) return;
  ui.setHeading(...headingFor(p));
  updatePauseScreen();
  ui.refreshPanel();
  syncNative();
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

const abortError = () => new Error('annulé');

/** Écarte les sources mémorisées comme lentes ou en échec pour ce titre (24 h), sauf s'il n'en reste aucune. */
function withoutBad(p, views) {
  const bad = badSources(badKey(p));
  const good = views.filter((v) => !bad.has(sourceKey(v)));
  return good.length ? good : views;
}

/** Message clair pour une erreur de débridage sur l'appareil. */
function clientError(e) {
  const code = e && e.code;
  if (code === 'no_provider') return 'Aucun débrideur configuré : ajoute une clé dans Réglages > Sources > Avancé.';
  if (code === 'all_unavailable') return 'Tous tes débrideurs sont indisponibles pour le moment (compte suspendu, quota ou clé invalide). Voir Réglages > Sources > Avancé.';
  if (code === 'host_not_allowed' || code === 'web_unsupported') return 'Ce débrideur ne peut pas être appelé depuis le navigateur : utilise l’application Windows ou Android.';
  if (code === 'not_ready') return 'Cette source n’est pas encore prête chez le débrideur (pas en cache).';
  return 'Débridage impossible' + (code ? ' (' + code + ')' : '') + '.';
}

async function resolveMedia(view, signal) {
  const s = view.stream;
  const up = await serverAlive();
  const base = serverBase();
  const hints = s.behaviorHints || {};
  if (typeof s.url === 'string' && /^https?:\/\//i.test(s.url)) {
    const ph = hints.proxyHeaders;
    if (up && ph && typeof ph === 'object') return { url: proxyUrl(base, s.url, ph.request || {}, ph.response || {}), up, base };
    return { url: s.url, up, base };
  }
  // Torrent livré sans lien par lastAddon : cache et déblocage sur l'appareil (AllDebrid, TorBox, Real-Debrid), jamais par le serveur.
  if (isClientStream(s)) {
    const { copies, season, episode } = clientCopiesOf(s);
    try {
      const r = await debrid().resolve(copies, { season, episode }, signal);
      if (P) P.debridVia = PROVIDER_LABEL[r.provider];
      return { url: r.url, up, base, provider: r.provider };
    } catch (e) {
      throw new Error(clientError(e));
    }
  }
  // Jamais de lecture torrent (P2P) : une source sans lien HTTP(S) n'est pas lisible, il faut un débrideur.
  throw new Error('Cette source n’a pas de lien lisible : un débrideur (AllDebrid) est nécessaire, la lecture torrent est désactivée.');
}

/** Clé « titre + épisode » des sources lentes ou en échec (mémorisées 24 h). */
const badKey = (p) => p.req.key + ':' + (p.cur.season ?? '') + ':' + (p.cur.episode ?? '');
const describeView = (v) => [v.quality, v.sourceType, v.langs.map((l) => l.label).join('/'), v.provider].filter(Boolean).join(' · ') || 'Source';

/**
 * Préparation d'une source, interruptible : lien (lastAddon /play débridé ou lien HTTP direct), sonde du fichier, choix du moteur et, pour le
 * transcodage, création de la session HLS (premier appel de la playlist, qui démarre le travail du serveur).
 * `direct` : même source mais en lecture directe, pour démarrer vite quand seule la piste audio demande le transcodage.
 */
async function prepareView(p, cand, signal) {
  const { view, direct } = cand;
  const shell = await connectShell();
  const native = !shell && isNativePlayer();
  // Android : le serveur de streaming Stremio tourne sur le même PC que lastAddon (port 11470), sauf réglage contraire.
  if (native && !storeGet(SERVER_KEY)) { const b = streamingServerFor(getBase()); if (b) setShellServerAddress(b); }
  if (signal.aborted) throw abortError();
  const media = await resolveMedia(view, signal);
  if (signal.aborted) throw abortError();
  let probe = p.hint && p.hint.url === media.url ? p.hint.probe : null;
  if (!shell && !native && media.up && !probe) probe = await fetchProbe(media.url, media.base, signal);
  if (signal.aborted) throw abortError();
  let choice = chooseEngine({
    shell: !!shell, native, serverUp: media.up, probe, caps: getCaps(), notWebReady: view.notWebReady,
    name: view.filename || media.url, forceTranscoding: p.forceHls && !direct,
    preferredLang: audioPreference()[0], audioTracksSupported: !!ui.video.audioTracks,
  });
  if (!direct && choice.engine === 'hls') {
    // Démarrage rapide possible : la vidéo passe telle quelle dans le navigateur, seul l'audio demande le transcodage.
    p.hint = { url: media.url, probe, fastDirect: !p.forceHls && directVideoOk(probe, getCaps()) };
  }
  if (direct && !native) choice = { engine: 'direct', viaServer: false, label: 'lecture directe (démarrage rapide)', reason: 'La vidéo est lisible telle quelle ; piste audio du fichier par défaut.' };
  const conversion = choice.engine === 'hls' ? probeConversion(probe, getCaps(), p.forceHls) : 'none';
  let hlsUrl = null;
  let hlsId = '';
  if (choice.engine === 'hls') {
    hlsId = newSessionId();
    hlsUrl = hlsMasterUrl(media.base, hlsId, media.url, getCaps(), p.forceHls);
    // Création de la session HLS côté serveur : c'est ici que le serveur remuxe ou réencode, donc ici que l'attente se joue.
    const res = await fetch(hlsUrl, { signal });
    if (!res.ok) throw new Error('le serveur de streaming a refusé la session (' + res.status + ')');
    await res.text();
  }
  console.debug('[player] session', { source: describeView(view), engine: choice.engine, conversion, direct: !!direct, hls: hlsUrl ? hlsId : null });
  return { shell, media, probe, choice, conversion, hlsUrl, hlsId, direct: !!direct };
}

/** Prochain candidat de la course : lecture directe de la même source, sinon la meilleure autre (langue, cache, lecture directe). */
function nextCandidate(p, tried) {
  const first = tried[0];
  if (p.hint && p.hint.fastDirect && !tried.some((c) => c.direct)) return { view: first.view, direct: true };
  const bad = new Set(badSources(badKey(p)).keys());
  const skip = new Set([...p.tried, ...tried.map((c) => c.view.index)]);
  const v = pickRaceCandidate(p.ranked, first.view, skip, bad, sourceKey);
  return v ? { view: v, direct: false } : null;
}

function recordRace(p, win) {
  const key = badKey(p);
  win.lost.forEach((f) => markBad(key, sourceKey(f.candidate.view), 'trop lente à démarrer'));
  win.failures.forEach((f) => markBad(key, sourceKey(f.candidate.view), f.message));
}

async function playView(view, startAt) {
  const p = P;
  if (!p) return;
  const token = p.token;
  const playId = (p.playId = (p.playId || 0) + 1);
  const stale = () => !P || P.token !== token || P.playId !== playId;
  if (p.race) { p.race.cancel(); p.race = null; }
  p.view = view;
  p.tried.add(view.index);
  p.attempts += 1;
  p.defaultsDone = false;
  p.applier.reset();
  p.autoToast = false;
  clearTimeout(p.nativeApplyTimer);
  p.failing = false;
  p.autoNexting = false;
  p.analyzed = false;
  p.hint = null;
  p.startAt = startAt || 0;
  const s = p.subs;
  Object.assign(s, { selectedId: null, secondaryId: null, cues2: [], native2: false, shift2: 0, swapped: false, cues: [], nativeCues: [], native: false, loadedFor: null, external: [], offset: 0, rate: 1, rateId: 'none', shift: 0, rateHint: '', syncKey: '' });
  stopAutoSync();
  if (thumbs) thumbs.reset();
  if (feed) feed.reset();
  if (rangeFeed) rangeFeed.reset();
  if (p.engine) { try { if (p.engine.kind === 'native') p.engine.detach(); else p.engine.destroy(); } catch (_) { /* ignoré */ } }
  ui.setError(null);
  ui.root.classList.remove('is-searching');
  p.phase = nextPhase(p.phase, 'open');
  ui.setPhase(p.phase);
  const line = (v) => sourceLine(v) + (v.status === 'cached' ? ' ⚡' : '');
  ui.setLoading(p.meta.title || 'Lecture', 'Préparation du lien…', loaderExtra(2, { source: line(view) }));
  // Course : la source choisie démarre seule ; passé 6 s, la suivante part en parallèle, la première prête gagne (12 s au plus
  // par candidat, 25 s ou 3 échecs au total).
  const race = raceCandidates({
    first: { view, direct: false },
    next: (tried) => nextCandidate(p, tried),
    run: (cand, signal) => prepareView(p, cand, signal),
    onProgress: ({ attempt, max, slow, candidate }) => {
      if (stale() || !slow) return;
      p.view = candidate.view;
      const msg = 'Ça prend du temps… ' + (candidate.direct ? 'essai en lecture directe' : 'essai d’une autre source') + ' (' + attempt + '/' + max + ')';
      ui.setLoading(p.meta.title || 'Lecture', msg, loaderExtra(2, { source: line(candidate.view), slow: true }));
    },
  });
  p.race = race;
  let win;
  try {
    win = await race.promise;
  } catch (err) {
    if (stale() || (err && err.kind === 'cancelled')) return;
    p.race = null;
    const failures = (err && err.failures) || [];
    failures.forEach((f) => markBad(badKey(p), sourceKey(f.candidate.view), f.message));
    p.view = null;
    showSourcesPanel(failures.map((f) => describeView(f.candidate.view) + (f.candidate.direct ? ' (lecture directe)' : '') + ' : ' + f.message));
    return;
  }
  if (stale()) return;
  p.race = null;
  recordRace(p, win);
  p.view = win.candidate.view;
  p.tried.add(p.view.index);
  try {
    await startPlan(p, win.value, startAt, stale, win.candidate);
  } catch (err) {
    if (stale()) return;
    failover(err && err.message ? err.message : 'Impossible de lancer la lecture');
  }
}

/** Charge la source préparée dans le moteur choisi. */
async function startPlan(p, plan, startAt, stale, cand) {
  const { shell, media, probe, choice } = plan;
  p.mediaUrl = media.url;
  p.mediaBase = media.base;
  p.mediaUp = !!media.up;
  p.probe = probe;
  p.probeTracks = parseProbe(probe);
  p.choice = choice;
  refreshAddonThumbs();
  p.conversion = plan.conversion;
  p.startedAt = Date.now();
  p.watch = new StallWatch(p.startedAt);
  ui.root.classList.toggle('is-mpv', choice.engine === 'mpv' || choice.engine === 'native');
  // Lecteur natif : transparent dès le départ (comme avant). mpv : transparent seulement à la première image (MpvEngine.showVideo).
  ui.root.classList.toggle('is-video', choice.engine === 'native' || (choice.engine === 'mpv' && !!mpv && mpv.transparent));
  ui.setMiniAvailable(true);
  if (nativeMini && choice.engine !== 'native') { nativeMini = false; if (nativeEng) nativeEng.closeNow(); miniState.reset(); }
  ui.relayoutMini();
  if (choice.engine === 'native') {
    if (!nativeEng) { nativeEng = new NativeEngine(NativePlayer); bindEngine(nativeEng); }
    p.engine = nativeEng;
    ui.video.hidden = true;
    await nativeEng.load({ url: media.url, startAt, open: nativeOptions() });
    pollMoreSources(p);
  } else if (choice.engine === 'mpv') {
    if (!mpv) { mpv = new MpvEngine(shell, ui.root); bindEngine(mpv); }
    p.engine = mpv;
    ui.video.hidden = true;
    await mpv.load({ url: media.url, startAt });
    if (miniState.mini && lastMiniRect) mpv.setMini(lastMiniRect);
  } else {
    p.engine = html;
    ui.video.hidden = false;
    p.hlsQuery = plan.hlsUrl ? hlsQuery(media.url, getCaps(), p.forceHls) : '';
    p.hlsId = plan.hlsId;
    p.mediaBase = media.base;
    await html.load({ url: plan.hlsUrl || media.url, hls: !!plan.hlsUrl, startAt });
  }
  if (stale()) return;
  ui.setPipAvailable(p.engine.supportsPip());
  ui.setSeries(p.req.type === 'tv', !!nextRef());
  if (cand && cand.direct) ui.toast('Lecture directe : piste audio par défaut. Pour une autre langue, choisis-la dans Audio (transcodage).', 7000);
  if (p.notice) { ui.toast(p.notice, 6000); p.notice = ''; }
  refreshUI();
  partyBridge.viewReady(partyAdapter(p));
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
    if (p.engine.kind === 'native') p.engine.closeNow();
    expandPlayer();
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
  if (P.engine.kind === 'native') { ensureExternalSubs(true); scheduleNativeApply(); return; } // pistes appliquées une fois la liste connue
  if (!P.defaultsDone) setTimeout(() => P && applyDefaultTracks(true), 700);
}

function onTracks() {
  if (!P) return;
  if (P.engine.kind === 'native') { if (P.applier.done) lateTracks(); else scheduleNativeApply(); ui.refreshPanel(); return; }
  if (!P.defaultsDone) applyDefaultTracks(false);
  else lateTracks();
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

/** Mode des sous-titres en vigueur : l'interrupteur des réglages (source de vérité) puis « Auto / Toujours » du panneau. */
function effectiveSubMode() {
  if (!getLangPrefs().subsOn) return 'off';
  return P && P.subs.style.mode === 'always' ? 'always' : 'auto';
}

/** Contexte du choix de pistes : langue d'origine du titre, mémoire de ce titre, capacités du moteur. */
function trackContext() {
  const p = P;
  const mem = getMemory(p.req.key);
  const origName = p.model && p.model.origLang ? String(p.model.origLang) : '';
  const lp = getLangPrefs();
  return {
    originalLang: origName ? langFromTitle(origName) || normalizeLang(origName) : '',
    unknownAudioLang: p.view && p.view.hasFrench && lp.audio === 'fr' ? 'fr' : '',
    alwaysSubs: effectiveSubMode() === 'always',
    rememberedAudio: mem.audio || '',
    rememberedSub: mem.sub || '',
    // Second sous-titre : piste texte dont on a l'adresse (calque de la page) ou piste embarquée affichée par mpv ; jamais en natif Android.
    canSecondary: (t) => p.engine.kind !== 'native' && (!!t.url || (p.engine.kind === 'mpv' && t.origin === 'embedded')),
  };
}

/** Ce que le moteur courant sait faire pour appliquer un choix de pistes. */
function trackSink() {
  const p = P;
  if (p.engine.kind === 'native') {
    return { setAudio: (id) => p.engine.setAudioTrack(id), setSub: (id) => p.engine.setSubtitleTrack(id === null ? null : id), setSecondary: () => {} };
  }
  return { setAudio: (id) => p.engine.setAudioTrack(id), setSub: (id) => selectSubtitle(id, true), setSecondary: (id) => selectSecondary(id) };
}

/** Message discret quand des sous-titres viennent d'être activés automatiquement (une fois par lecture). */
function announceAuto(pick) {
  const p = P;
  if (!p || !pick || p.autoToast) return;
  const main = normalizeLang(getLangPrefs().audio);
  // Sous-titres forcés d'un audio dans la langue principale : rien à annoncer.
  if (pick.audioLang && pick.audioLang === main && !getLangPrefs().learn && effectiveSubMode() !== 'always') return;
  const msg = autoSubsToast(pick);
  if (!msg) return;
  p.autoToast = true;
  ui.toast(msg, 4500);
}

/** Piste audio et sous-titres initiaux d'après les langues du profil, une seule fois par source (quand le moteur a annoncé ses pistes). */
function applyDefaultTracks(force) {
  const p = P;
  if (!p || p.defaultsDone) return;
  const audio = p.engine.audioTracks();
  const subs = allSubtitleTracks();
  if (!audio.length && !subs.length && !force) return;
  p.defaultsDone = true;
  const pick = p.applier.apply(audio, subs, getLangPrefs(), trackContext(), trackSink(), true);
  let audioLang = pick ? pick.audioLang : '';
  if (!audio.length) audioLang = p.view.hasFrench ? 'fr' : '';
  p.audioLang = audioLang;
  p.autoAppliedAt = Date.now();
  announceAuto(pick);
  ensureExternalSubs(true);
}

/** Sous-titres externes arrivés après le démarrage : complètent ce qui manquait, sans rien changer à un choix déjà fait. */
function lateTracks() {
  const p = P;
  if (!p || !p.defaultsDone) return;
  const pick = p.applier.late(p.engine.audioTracks(), p.engine.kind === 'native' ? p.engine.subtitleTracks() : allSubtitleTracks(), getLangPrefs(), trackContext(), trackSink());
  if (pick) { p.autoAppliedAt = Date.now(); announceAuto(pick); }
}

/** Lecteur natif Android : la liste des pistes n'est complète qu'un instant après le début ; on applique une fois, sans double sous-titre. */
function scheduleNativeApply() {
  const p = P;
  if (!p || p.applier.done) return;
  clearTimeout(p.nativeApplyTimer);
  p.nativeApplyTimer = setTimeout(() => {
    if (!P || P !== p || p.applier.done) return;
    const audio = p.engine.audioTracks();
    const subs = p.engine.subtitleTracks();
    if (!audio.length && !subs.length) return;
    p.defaultsDone = true;
    const pick = p.applier.apply(audio, subs, getLangPrefs(), trackContext(), trackSink(), true);
    p.audioLang = pick ? pick.audioLang : '';
    p.autoAppliedAt = Date.now();
    announceAuto(pick);
  }, 700);
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
    const id = p.imdb ? (p.req.type === 'tv' ? episodeStreamId(p.imdb, p.req.season, p.req.episode, p.req.streamId) : p.imdb) : '';
    if (!id) return;
    const type = p.req.type === 'tv' ? 'series' : 'movie';
    const addon = isConfigured() ? addonUrl('subtitles/' + type + '/' + id + '.json') : null;
    const list = await fetchExternalSubtitles({ type, id, hash: params && params.hash, size: (params && params.size) || view.sizeBytes || null, filename: view.filename }, addon, wantedSubLang(getLangPrefs()));
    if (!P || P.token !== token || P.view !== view) return;
    p.subs.external = list;
    p.subs.loadedFor = view.index;
    if (p.engine.kind === 'native') { p.engine.addSubtitles(toNativeSubtitles(list, wantedSubLang(getLangPrefs()))); return; }
    if (auto && p.defaultsDone) lateTracks();
  } finally {
    if (P && P.token === token) { p.subs.loading = false; ui.refreshPanel(); }
  }
}

async function selectSubtitle(id, quiet) {
  const p = P;
  if (!p) return;
  const s = p.subs;
  if (s.swapped) clearSecondary();
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

/** Retire le second sous-titre (et rend à mpv ses deux sous-titres dans l'ordre normal). */
function clearSecondary() {
  const p = P;
  if (!p) return;
  const s = p.subs;
  if (s.secondaryId && p.engine.supportsSecondary && p.engine.supportsSecondary()) p.engine.setSecondarySubtitleTrack(null);
  Object.assign(s, { secondaryId: null, cues2: [], native2: false, shift2: 0, swapped: false });
}

/**
 * Second sous-titre (mode apprentissage) : la langue apprise reste le sous-titre principal (en haut) et la langue principale
 * passe dessous. mpv affiche lui-même les pistes embarquées (le second en haut : on échange alors les deux emplacements) ;
 * sinon la page affiche les cues des pistes dont on a l'adresse.
 */
async function selectSecondary(id) {
  const p = P;
  if (!p) return;
  const s = p.subs;
  if (!id) { clearSecondary(); ui.refreshPanel(); return; }
  const tracks = allSubtitleTracks();
  const track = tracks.find((t) => t.id === id);
  if (!track) return;
  const first = tracks.find((t) => t.id === s.selectedId);
  s.secondaryId = id;
  s.cues2 = [];
  s.native2 = false;
  s.shift2 = 0;
  s.swapped = false;
  if (track.origin === 'embedded' && !track.url) {
    if (!(p.engine.supportsSecondary && p.engine.supportsSecondary())) { s.secondaryId = null; return; }
    s.native2 = true;
    if (first && first.origin === 'embedded' && !first.url && s.native) {
      // Les deux pistes sont affichées par mpv : le second sous-titre y est en haut, donc la langue apprise.
      p.engine.setSubtitleTrack(track.id);
      p.engine.setSecondarySubtitleTrack(first.id);
      s.swapped = true;
    } else {
      p.engine.setSecondarySubtitleTrack(track.id);
    }
    ui.refreshPanel();
    return;
  }
  if (track.origin === 'embedded') s.shift2 = -p.probeTracks.startTime;
  try {
    const up = await serverAlive();
    const via = up && track.origin === 'external' ? subtitlesVttUrl(serverBase(), track.url) : track.url;
    let text = '';
    try { text = await (await fetch(via)).text(); } catch (_) { text = await (await fetch(track.url)).text(); }
    if (P === p && s.secondaryId === id) {
      s.cues2 = parseSubtitles(text, track.url);
      if (!s.cues2.length) s.secondaryId = null;
    }
  } catch (_) {
    if (P === p && s.secondaryId === id) s.secondaryId = null;
  }
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
  if (partyBridge.guestLocked()) return; // en salon, c'est l'hôte qui passe à l'épisode suivant
  const nx = autoNextEpisode(nextRef(), p.episodes); // jamais vers un épisode pas encore diffusé : lancement manuel
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
  partyBridge.tick(partyAdapter(p));
  // Sous-titres (100 ms).
  const s = p.subs;
  let cues = s.cues;
  if (s.native && p.engine.kind === 'html') {
    if (tickN % 5 === 0) s.nativeCues = p.engine.nativeCues();
    cues = s.nativeCues || [];
  }
  const cue = p.engine.kind === 'native' || (s.native && p.engine.kind === 'mpv') ? null : activeCue(cues, st.time, s.offset + s.shift, s.rate);
  const cue2 = s.secondaryId && !s.native2 && p.engine.kind !== 'native' ? activeCue(s.cues2, st.time, s.shift2, 1) : null;
  ui.setCue(cue ? cueHtml(cue.text) : '', s.style, cue2 ? cueHtml(cue2.text) : '');
  if (tickN % 3 === 0) refreshUI(st);
  if (tickN % 10 !== 0) return;
  // Chaque seconde : blocage, saut, carte suivante, progression.
  if (p.choice && !p.failing && !p.resumeTimer) {
    const verdict = p.watch.tick(Date.now(), st.time, st.paused || st.ended || st.seeking);
    if (verdict === 'stalled') failover('La lecture est bloquée depuis plus de 15 s');
    else if (verdict === 'startup-timeout') failover('La source met trop de temps à démarrer');
  }
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
    // Mini-lecteur : ni pastille de saut ni carte (le saut automatique, s'il est activé, reste actif plus haut).
    const mini = miniState.mini;
    ui.setSkip(!mini && seg && p.skipped !== seg.start ? seg : null);
    const nx = autoNextEpisode(nextRef(), p.episodes); // épisode non diffusé : ni carte ni enchaînement automatique
    const card = nextEpisodeCard(p.segments, st.time, st.duration, !!nx, getSkipPref('nextEpisode'));
    if (card.show && !p.nextDismissed && nx) {
      const ep = p.episodes.get(nx.season);
      const info = ep && ep.find((e) => e.episode === nx.episode);
      if (!mini) ui.setNextCard({ title: 'S' + nx.season + ':É' + nx.episode + (info && info.name ? ' « ' + info.name + ' »' : ''), still: info ? info.still : '', countdown: card.countdown, ratio: card.ratio });
      if (!ep) ensureEpisodes(nx.season);
      if (card.countdown === 0 && !p.autoNexting && !partyBridge.guestLocked()) { p.autoNexting = true; playEpisode(nx.season, nx.episode); }
    } else ui.setNextCard(null);
    ui.setEndRow(!mini && p.req.type === 'movie' && !p.endDismissed && movieEndRow(p.segments, st.time, st.duration));
    if (!st.paused) saveProgress(false, st);
    maybeAnalyze(st);
    maybeRepoll(st);
    if (!p.watchedMarked && isWatched(st.time, st.duration)) markWatched();
  }
}

/** Une fois par épisode, lastAddon reçoit le lien lu pour analyser l'épisode (intro, générique). Les erreurs sont ignorées. */
function maybeAnalyze(st) {
  const p = P;
  if (p.analyzed || !p.imdb || !isConfigured() || st.time < 3 || !validAnalyzeDuration(st.duration)) return;
  const played = typeof p.view.stream.url === 'string' && /^https?:/i.test(p.view.stream.url) ? p.view.stream.url : p.mediaUrl;
  const url = analyzeUrl(played, serverBase()) || analyzeUrl(p.mediaUrl, serverBase());
  p.analyzed = true;
  if (!url) return;
  const tgt = submitTarget();
  postLt('skip/analyze', { ...tgt, mediaUrl: url, duration: Math.round(st.duration) }).catch(() => undefined);
}

/** Pendant que lastAddon analyse, on redemande les segments (30 s, 10 fois au plus) et les boutons se mettent à jour. */
function maybeRepoll(st) {
  const p = P;
  const sp = p.skipPoll;
  if (!shouldRepoll({ analyzing: sp.analyzing, polls: sp.polls, lastAt: sp.lastAt, now: Date.now(), playing: !st.paused })) return;
  sp.polls += 1;
  sp.lastAt = Date.now();
  const t = submitTarget();
  skipSegments(t.type, t.imdbId, t.season, t.episode).then((r) => {
    if (P !== p) return;
    p.segments = normalizeSkip(r);
    sp.analyzing = !!r && r.analyzing === true;
  }).catch(() => undefined);
}

function refreshUI(st) {
  if (!P || !P.engine || !P.view) return;
  const s = st || P.engine.state();
  // Première image prête : le chargeur s'efface en fondu, puis les contrôles apparaissent (et se masquent seuls après 3 s).
  if (P.phase === 'loading' && !P.resumeTimer && !ui.panel && !P.failing && shouldBeReady(s)) {
    P.phase = nextPhase(P.phase, 'media');
    ui.setLoading(null);
    ui.setPhase(P.phase);
  }
  ui.update(shell ? { ...s, fullscreen: shellFullscreen } : s, chapterMarks(P.segments, s.duration));
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

/** Salon : seul l'hôte pilote ; un invité qui essaie est prévenu. */
function guestBlocked() {
  if (!partyBridge.guestLocked()) return false;
  ui.toast('Seul l’hôte du salon pilote la lecture', 1800);
  return true;
}

function seekTo(t) {
  if (!P || !P.view || guestBlocked()) return;
  P.engine.seek(t);
  P.watch.reset(Date.now());
  P.skipped = null;
}

function seekBy(d) {
  if (!P || !P.view || guestBlocked()) return;
  const st = P.engine.state();
  const to = Math.min(st.duration || Infinity, Math.max(0, st.time + d));
  seekTo(to);
  ui.toast((d > 0 ? '+' : '−') + Math.abs(d) + ' s', 900);
  ui.previewTime(to);
}

function togglePlay() {
  if (!P || !P.view || guestBlocked()) return;
  const st = P.engine.state();
  if (st.paused) P.engine.play(); else { P.engine.pause(); saveProgress(true); }
}

async function toggleFullscreen() {
  // Dans la coque, c'est la fenêtre qui passe en plein écran (mpv est dessous), pas un élément de la page.
  if (shell) { shellFullscreen = !shellFullscreen; setShellFullscreen(shell, shellFullscreen); refreshUI(); return; }
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await ui.root.requestFullscreen();
  } catch (_) { ui.toast('Plein écran indisponible'); }
}

async function togglePip() {
  // Coque Windows : mpv est sous la page, donc c'est la fenêtre entière qui devient une petite fenêtre au premier plan.
  if (shell && P && P.engine.kind === 'mpv') { setShellPip(shell, !shellPip); return; }
  if (!P || !P.view || !P.engine.supportsPip()) { ui.toast('Image dans l’image indisponible ici'); return; }
  try { await P.engine.togglePip(); } catch (_) { ui.toast('Image dans l’image refusée par le navigateur'); }
}

/** Sélecteur de sources dans un panneau du lecteur : recherche initiale sans résultat, lecture automatique désactivée, changement de source. */
function showSourcesPanel(reasons = []) {
  const p = P;
  if (!p) return;
  if (nativeEng && p.engine === nativeEng) nativeEng.closeNow(); // le panneau web passe par-dessus : l'activité native se ferme
  expandPlayer();
  ui.setLoading(null);
  ui.root.classList.remove('is-searching');
  const host = ui.mountPanel('sources', 'Sources');
  openSourcePicker(p.req, null, {
    host, views: p.views, pending: p.pending || [], imdb: p.imdb, currentIndex: p.view ? p.view.index : null, notice: reasons,
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
  if (!p || guestBlocked()) return Promise.resolve();
  ui.closePanel(true);
  const info = (p.episodes.get(season) || []).find((e) => e.episode === episode);
  // Identifiant de flux de la structure canonique : même numérotation que l'épisode affiché (progression « vu » inchangée).
  const streamId = (info && info.streamId) || null;
  return playBest({ ...p.req, season, episode, imdb: p.imdb, streamId }, p.opener, { resume: 'none', notYetAired: info && !info.aired ? info.airDate : '' });
}

/** Message quand un épisode pas encore diffusé n'a aucune source (la recherche décide de la lecture). */
const notYetAiredMessage = (iso) => 'Pas encore disponible — diffusion le ' +
  new Date(iso + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

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
  if (act === 'minimize') { if (!minimizePlayer()) closePlayer(); return; }
  if (act === 'expand') { expandPlayer(); return; }
  if (act === 'party') { togglePartyPanel(); return; }
  if (act === 'source') { showSourcesPanel(); return; }
  if (act === 'choose-myself') {
    if (P.race) { P.race.cancel(); P.race = null; }
    P.view = null;
    showSourcesPanel();
    return;
  }
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
    case 'langsettings': closePlayer(); location.hash = '#/settings'; break;
    case 'resume': chooseResume(true); break;
    case 'restart': chooseResume(false); break;
    case 'retry': { const v = P.view; P.tried = new Set(); P.attempts = 0; playView(v, st.time > 5 ? st.time : 0); break; }
    case 'audio': {
      const t = P.engine.audioTracks().find((x) => x.id === data.id);
      if (t && t.lang) remember(P.req.key, { audio: t.lang });
      P.applier.markManual();
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
      P.applier.markManual();
      clearSecondary();
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
    case 'thumbs': storeSet(THUMBS_KEY, storeGet(THUMBS_KEY) === '0' ? '1' : '0'); thumbs.cancel(); cancelAddonThumb(); ui.refreshPanel(); break;
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
  // « Par défaut : Auto / Toujours / Jamais » : « Jamais » coupe les sous-titres automatiques du profil (réglage Audio et sous-titres).
  if (patch.mode !== undefined) { setLangPrefs({ subsOn: next.mode !== 'off' }); pushPrefs(); }
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
        sections: sectionSubtitleTracks(subTracks, [wantedSubLang(getLangPrefs())], titles), selectedId: s.selectedId, offset: s.offset, rate: s.rateId, rateHint: s.rateHint,
        style: { ...s.style, mode: effectiveSubMode() }, styleOpen: s.styleOpen, loading: s.loading,
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
      rate: st.rate, source: rows, aspect: p.aspect, thumbs: storeGet(THUMBS_KEY) !== '0', thumbsAvailable: thumbSourceOf(p).mode !== 'none', autoPip: storeGet(AUTOPIP_KEY) === '1', pipAvailable: p.engine.supportsPip(), autoPipAvailable: p.engine.kind !== 'mpv' && p.engine.supportsPip(),
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
      seasons: p.seasons, season: s, episodes: filterEpisodes(all, p.epQuery), loading: !!p.episodesLoading, error: !!p.episodesError, current: p.cur, query: p.epQuery,
      logo: p.meta.logo, backdrop: p.meta.backdrop ? IMG('w780', p.meta.backdrop) : '', title: p.meta.title, total: all.length, watchedCount: all.filter((e) => e.watched).length,
    };
  }
  if (name === 'info') {
    const v = p.view;
    const eps = p.episodes.get(p.cur.season);
    const ep = eps && eps.find((e) => e.episode === p.cur.episode);
    const [title, sub] = headingFor(p);
    const rows = [
      ['Moteur', p.choice ? p.choice.label : '…'],
      ['Conversion', p.choice && p.choice.engine === 'hls' ? CONVERSION_LABEL[p.conversion || 'unknown'] : 'Aucune (lecture directe)'],
      ['Qualité', [v.quality, v.sourceType, v.codec, ...v.hdr].filter(Boolean).join(' · ')],
      ['Origine', v.origins.map((o) => o.name).join(', ') || 'Inconnue'],
      ['Audio', v.audio || 'Inconnu'],
      ['Taille', [v.sizeLabel, v.bitrateLabel, v.durationLabel && '≈ ' + v.durationLabel].filter(Boolean).join(' · ') || 'Inconnue'],
      ['Statut', v.statusLabel],
      ['Fichier', v.filename || '—'],
    ];
    if (v.releaseGroup) rows.push(['Release', v.releaseGroup]);
    if (p.probeTracks.height) rows.push(['Vidéo', p.probeTracks.width + '×' + p.probeTracks.height + ' · ' + (p.probeTracks.videoCodec || '').toUpperCase()]);
    if (p.choice) rows.push(['Pourquoi ce moteur', p.choice.reason]);
    // Le serveur de streaming ne sert plus qu'à la conversion HLS (web) : sinon, lecture directe du lien débridé.
    if (p.debridVia) rows.push(['Débridé par', p.debridVia]);
    rows.push(['Serveur de streaming', p.choice && p.choice.viaServer ? serverBase() : 'Non utilisé · lecture directe du lien débridé']);
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
  // Mini-lecteur : aucun raccourci global, sauf « I » pour agrandir (jamais pendant une saisie).
  if (miniState.mini) {
    const field = !!(t && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
    if ((e.key === 'i' || e.key === 'I') && !field && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat) { e.preventDefault(); e.stopImmediatePropagation(); expandPlayer(); }
    return;
  }
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
    case 'mini': if (!minimizePlayer()) ui.toast('Réduction indisponible ici'); break;
    case 'next': onAction('next'); break;
    case 'back':
      switch (backStep({ panelOpen: !!ui.panel, shellFullscreen: !!shell && shellFullscreen, docFullscreen: !!document.fullscreenElement, shellPip: !!shell && shellPip })) {
        case 'panel': ui.closePanel(); break;
        case 'shell-pip': togglePip(); break;
        case 'shell-fullscreen': toggleFullscreen(); break;
        case 'doc-fullscreen': document.exitFullscreen().catch(() => {}); break;
        default: closePlayer();
      }
      break;
    default: break;
  }
}

// ---------- Fermeture ----------

async function teardown(silent) {
  const p = P;
  if (!p) return;
  if (!silent) nativeMini = false;
  resetMini();
  saveProgress(true);
  clearInterval(tickTimer);
  clearTimeout(p.resumeTimer);
  stopAutoSync();
  if (thumbs) thumbs.reset();
  if (feed) feed.reset();
  if (rangeFeed) rangeFeed.reset();
  try { if (silent && p.engine.kind === 'native') p.engine.detach(); else p.engine.destroy(); } catch (_) { /* ignoré */ }
  if (document.pictureInPictureElement) { try { await document.exitPictureInPicture(); } catch (_) { /* ignoré */ } }
  P = null;
  partyBridge.sessionClosed(silent);
  if (!silent) {
    setWatching(null);
    if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch (_) { /* ignoré */ } }
    ui.hide();
    document.body.classList.remove('modal-open', 'lp-open');
  }
}

export function closePlayer() {
  if (!P) return;
  // Fenêtre de la coque restée en plein écran : on la rend à sa taille normale en quittant le lecteur.
  if (shell && shellFullscreen) { shellFullscreen = false; setShellFullscreen(shell, false); }
  if (shell && shellPip) setShellPip(shell, false);
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
  // Liste vide sans recherche en cours : le panneau explique pourquoi ; vide mais encore en cours : on attend la suite.
  if (!loaded || (!loaded.views.length && !loaded.pending.length)) {
    if (opts.notYetAired) ui.toast(notYetAiredMessage(opts.notYetAired));
    showSourcesPanel();
    return;
  }
  request.imdb = loaded.imdb;
  p.imdb = loaded.imdb;
  p.views = loaded.views;
  p.pending = loaded.pending;
  p.loaded = loaded;
  p.ranked = [...loaded.views];
  if (opts.picker || (!getAutoplay() && !opts.force)) { showSourcesPanel(); return; }
  ui.setLoading(p.meta.title || 'Lecture', 'Choix de la meilleure source…', loaderExtra(1));
  const bw = await measureBandwidthKbps().catch(() => null);
  if (!alive()) return;
  // Salon : la version de l'hôte (empreinte) passe avant la « meilleure » source ; chacun lit avec SA source.
  const recommend = (views) => {
    const usable = withoutBad(p, views);
    const same = opts.prefer ? opts.prefer(usable) : null;
    return same ? { view: same, reason: 'Même version que l’hôte du salon', party: true } : recommendFor(usable, bw);
  };
  const good = (r) => !!r && (r.party === true || isGoodMatch(r));
  let rec = recommend(loaded.views);
  // Réponse partielle : on part tout de suite si la meilleure source disponible est une bonne correspondance (cache, langue
  // préférée, 1080p ou mieux) ; sinon on attend le reste de la recherche, 20 s au plus.
  let cur = loaded;
  const t0 = Date.now();
  while (cur.pending.length && !good(rec) && Date.now() - t0 < POLL_MAX_MS) {
    ui.setLoading(p.meta.title || 'Lecture', describePending(cur.pending), loaderExtra(0));
    await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
    if (!alive()) return;
    const next = await pollSources(request, cur);
    if (!alive()) return;
    if (next !== cur) {
      cur = next;
      p.views = next.views;
      p.pending = next.pending;
      p.loaded = next;
      p.ranked = [...next.views];
      rec = recommend(next.views);
    }
  }
  loaded.views = cur.views;
  loaded.pending = cur.pending;
  if (!rec) { showSourcesPanel(); return; }
  ui.setLoading(p.meta.title || 'Lecture', rec.reason, loaderExtra(2, { source: sourceLine(rec.view) + (rec.view.status === 'cached' ? ' ⚡' : '') }));
  await continueWith(rec.view, { resume: p.resumeMode, notice: rec.languageFallback ? rec.reason : '' });
}

/** Lance une source choisie dans le sélecteur de la fiche. */
export function playSource(request, views, view, opener, opts = {}) {
  return startSession(request, views, view, { opener, resume: opts.resume || 'ask' });
}

// Salon (watch party) : le pont lance les épisodes demandés par l'hôte avec la source la plus proche de son empreinte.
partyBridge.launcher = (request, o) => playBest(request, null, { resume: o.resume, force: true, prefer: o.prefer });
partyBridge.adapter = () => partyAdapter();

export { formatClock };
