/* Port du prototype (voir tools/port-prototype.mjs). */
import { tvHlsUrl } from '../data/lt';
import { channelNumber } from '../data/tvRank';
import { LI } from '../player/icons.js';
import { stopPreview } from './preview.js';
import { exitExternalFullscreen, externalControls, externalKind, externalSample, startExternal, stopExternal } from './tvExternal.js';
import { bannerEl, ensureEpg, epgKey, fmtHM, nowNext, perrEl, playerEl, setChannelDown, statusEl, tv, videoEl } from './tv.js';
import { pillView, reasonOfExternal, reasonOfHls, reduceTvStatus, renderTvStatus, statusView } from './tvStatus.js';
import {
  IdleUi, UI_IDLE_MS, hlsAudioOptions, hlsLevelOptions, hlsSubtitleOptions, hlsTech, htmlAudioList, htmlAudioOptions,
  htmlTextList, htmlTextOptions, infoModel, liveBadge, tvKeyAction,
} from './tvControls.js';
import { esc, store } from './util.js';

// ---------- Lecteur plein écran ----------
export function loadHls() {
  if (!tv.hlsPromise) {
    // hls.js est une dépendance npm, chargée à la demande (hors paquet principal).
    tv.hlsPromise = import('hls.js').then((m) => m.default);
    tv.hlsPromise.catch(() => { tv.hlsPromise = null; });
  }
  return tv.hlsPromise;
}

export const curChannel = () => (tv.play ? tv.play.list[tv.play.idx] : null);

// Icônes de la barre : mêmes glyphes que le lecteur des films (src/player/icons.js) ; chevrons et CC propres au direct.
const stroke = (d, w = 2) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + w + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
const CC_ICON = stroke('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 10.5a2 2 0 1 0 0 3M16 10.5a2 2 0 1 0 0 3"/>');
const ICON = { play: LI.play, pause: LI.pause, vol: LI.vol, mute: LI.mute, full: LI.full, fullExit: LI.fullExit };

const $ = (sel) => playerEl.querySelector(sel);
const infoEl = $('#player-info');
const panelEl = $('#player-panel');
const chnameEl = $('#player-chname');
const liveEl = $('#player-live');

/** Masquage automatique de l'interface (en-tête, cartouche, barre) ; `panel` : panneau ouvert (audio, sous-titres, chaînes…). */
const idle = new IdleUi(UI_IDLE_MS);
let idleTimer = 0;
let panel = null;

const setIcon = (sel, svg) => { const b = $(sel); if (b && b.innerHTML !== svg) b.innerHTML = svg; };
const setHidden = (sel, hidden) => { const b = $(sel); if (b) b.hidden = !!hidden; };
const setAttr = (sel, name, value) => { const b = $(sel); if (b) b.setAttribute(name, value); };
const ignore = (r) => { if (r && typeof r.catch === 'function') r.catch(() => {}); };

function mountIcons() {
  setIcon('[data-pprev]', stroke('<path d="M6 15l6-6 6 6"/>', 2.4));
  setIcon('[data-pnext]', stroke('<path d="M6 9l6 6 6-6"/>', 2.4));
  setIcon('[data-ptrack="audio"]', LI.tracks);
  setIcon('[data-ptrack="sub"]', CC_ICON);
  setIcon('[data-ptrack="quality"]', LI.gear);
  setIcon('[data-ppip]', LI.pip);
  setIcon('[data-plist]', LI.list);
}
mountIcons();

/**
 * Commandes de la lecture, quelle que soit la sortie : lecteur externe (mpv, plugin natif) si actif, sinon la balise vidéo
 * de la page (hls.js ou lecture native). Même forme dans les deux cas (tvExternal.js : externalControls).
 */
function ctl() {
  const ext = externalControls();
  if (ext) return ext;
  const h = () => tv.hls;
  return {
    kind: 'web',
    paused: () => videoEl.paused,
    togglePause() { if (videoEl.paused) ignore(videoEl.play()); else videoEl.pause(); },
    canVolume: true,
    muted: () => videoEl.muted,
    setMuted(m) { videoEl.muted = !!m; },
    volume: () => videoEl.volume,
    setVolume(v) { videoEl.volume = Math.min(1, Math.max(0, v)); if (videoEl.volume > 0) videoEl.muted = false; },
    canFullscreen: !!document.fullscreenEnabled && typeof playerEl.requestFullscreen === 'function',
    fullscreen: () => document.fullscreenElement === playerEl,
    setFullscreen(on) {
      if (on) ignore(playerEl.requestFullscreen());
      else if (document.fullscreenElement) ignore(document.exitFullscreen());
    },
    canPip: !!document.pictureInPictureEnabled && typeof videoEl.requestPictureInPicture === 'function',
    pip: () => document.pictureInPictureElement === videoEl,
    setPip(on) { ignore(on ? videoEl.requestPictureInPicture() : document.exitPictureInPicture()); },
    audio: () => (h() ? hlsAudioOptions(h()) : htmlAudioOptions(videoEl.audioTracks)),
    setAudio(id) {
      if (h()) { h().audioTrack = Number(id); return; }
      htmlAudioList(videoEl.audioTracks).forEach((t, i) => { t.enabled = i === Number(id); });
    },
    subs: () => (h() ? hlsSubtitleOptions(h()) : htmlTextOptions(videoEl.textTracks)),
    setSub(id) {
      const n = Number(id);
      if (h()) { h().subtitleTrack = n; h().subtitleDisplay = n >= 0; return; }
      htmlTextList(videoEl.textTracks).forEach((t, i) => { t.mode = i === n ? 'showing' : 'disabled'; });
    },
    levels: () => (h() ? hlsLevelOptions(h()) : []),
    setLevel(id) { if (h()) h().currentLevel = Number(id); }, // -1 : Auto
    tech() {
      const t = h() ? hlsTech(h()) : {};
      if (videoEl.videoWidth) { t.width = videoEl.videoWidth; t.height = videoEl.videoHeight; }
      return t;
    },
  };
}

/** Sortie du plein écran (page ou coque) : appelé avant de fermer le lecteur. */
function leaveFullscreen() {
  exitExternalFullscreen();
  if (document.fullscreenElement) ignore(document.exitFullscreen());
}

export function destroyStream() {
  clearTimeout(tv.stallTimer);
  clearInterval(tv.watchTimer);
  stopExternal();
  if (tv.hls) { try { tv.hls.destroy(); } catch (_) { /* déjà détruit */ } tv.hls = null; }
  videoEl.removeAttribute('src');
  try { videoEl.load(); } catch (_) { /* ignoré */ }
}

/** Verrouillé : l'interface reste visible tant qu'un panneau est ouvert, que la lecture est en pause ou qu'un échec est affiché. */
const locked = () => tv.info || !!panel || !perrEl.hidden || ctl().paused();

function setIdleClass() {
  idle.lock(locked());
  playerEl.classList.toggle('is-idle', !idle.visible(Date.now()));
}

/** Met l'interface à jour et programme le masquage au prochain délai d'inactivité (un seul minuteur à la fois). */
function armIdle() {
  setIdleClass();
  const at = idle.deadline();
  if (idleTimer || at == null || at <= Date.now()) return;
  idleTimer = setTimeout(() => { idleTimer = 0; armIdle(); }, at - Date.now() + 1);
}

/** Activité (souris, toucher, touche) : l'interface revient pour UI_IDLE_MS. */
export function wakeUi() {
  idle.wake(Date.now());
  armIdle();
}

/** Réécrit `el` seulement si son contenu change : le focus clavier et le défilement survivent aux rafraîchissements. */
function setHtml(el, html) {
  if (el.dataset.html === html) return;
  el.dataset.html = html;
  el.innerHTML = html;
}

export function updateBanner() {
  const c = curChannel();
  if (!c) return;
  const now = Math.floor(Date.now() / 1000);
  const nn = nowNext(c, now);
  const pct = nn.cur ? Math.max(0, Math.min(100, Math.round(((now - nn.cur.start) / (nn.cur.stop - nn.cur.start)) * 100))) : 0;
  const logo = '<span class="pb-logo">' + (c.logo ? '<img src="' + esc(c.logo) + '" alt="">' : '<b>' + esc(c.name.slice(0, 3)) + '</b>') + '</span>';
  setHtml(bannerEl, logo + '<span class="pb-text">' +
    (nn.cur ? '<span class="pb-now"><strong>En cours</strong> ' + esc(nn.cur.title) + ' · ' + fmtHM(nn.cur.start) + ' – ' + fmtHM(nn.cur.stop) + '</span><span class="progress pb-prog" aria-hidden="true"><span style="width:' + pct + '%"></span></span>' : '<span class="pb-now">Programme non communiqué</span>') +
    (nn.next ? '<span class="pb-next">Ensuite : ' + esc(nn.next.title) + ' · ' + fmtHM(nn.next.start) + '</span>' : '') + '</span>');
}

/** Met à jour le signal d'état du lecteur (pastille en haut, badge DIRECT dans la barre) à partir d'un événement de tvStatus.js. */
function setStatus(ev) {
  tv.status = reduceTvStatus(tv.status, ev);
  renderTvStatus(statusEl, pillView(tv.status));
  refreshBar();
}

/** Chaîne qui repart après un échec de cette session : elle n'est plus grisée. */
function recovered() {
  const ch = curChannel();
  if (ch && ch.id && tv.failed.has(ch.id)) setChannelDown(ch.id, false);
}

/** Échantillon de lecture pour le signal : lecteur externe si actif, sinon la vidéo de la page. */
function playbackSample() {
  if (externalKind()) return externalSample() || { time: 0, hasVideo: false, paused: true };
  return { time: videoEl.currentTime || 0, hasVideo: videoEl.videoWidth > 0, paused: videoEl.paused };
}

/** Échantillonnage du signal chaque seconde pendant la lecture (la logique d'état est dans tvStatus.js). */
function watchStatus() {
  clearInterval(tv.statusTimer);
  tv.statusTimer = setInterval(() => {
    if (playerEl.hidden) return;
    setStatus(Object.assign({ type: 'sample', now: Date.now() }, playbackSample()));
    if (tv.status.phase === 'live') recovered();
    updateBanner();
    if (tv.info) renderInfo();
  }, 1000);
}

/** Échec définitif d'une chaîne (plus aucune source) : message, raison, chaîne grisée pour la session. */
export function playFail(token, reason, c) {
  if (token !== tv.playToken) return;
  clearTimeout(tv.stallTimer);
  const ch = c || curChannel();
  if (ch && ch.id) setChannelDown(ch.id, true);
  setStatus({ type: 'fail', reason });
  const why = statusView(tv.status).reason;
  const r = perrEl.querySelector('.player-reason');
  if (r) r.textContent = why;
  perrEl.hidden = false;
  const b = perrEl.querySelector('[data-pnext]');
  if (b) b.focus();
  wakeUi();
}

/**
 * Flux d'une chaîne, dans l'ordre d'essai. Quand le serveur n'a pas de proxy HLS (Workers : `sig` nul), le lecteur lit
 * l'URL du flux directement ; dans une page web, les flux marqués `direct === false` (http, sans CORS) sont alors écartés
 * (mpv et libVLC n'ont pas besoin de CORS et les gardent). Si rien ne reste, on tente tout de même la liste complète.
 */
const sourcesOf = (c) => {
  const all = [{ url: c.url, sig: c.sig, direct: c.direct }].concat(c.alternatives || []);
  if (externalKind()) return all;
  const usable = all.filter((s) => s.sig || s.direct !== false);
  return usable.length ? usable : all;
};
const isDirectFile = (u) => /\.(mp4|webm|mkv|ts)(\?|$)/i.test(u);

export function startStream() {
  const c = curChannel();
  if (!c) return;
  const token = ++tv.playToken;
  tv.attempt = 0;
  store('ls_tv_last', { id: c.id, name: c.name, logo: c.logo, group: c.group, cat: c.cat, source: c.source, fast: c.fast, url: c.url, epgId: c.epgId, flaky: !!c.flaky, sig: c.sig, alternatives: c.alternatives || [] });
  updateBanner();
  wakeUi();
  if (tv.info) renderInfo();
  ensureEpg([c]).then(() => { if (token === tv.playToken) { updateBanner(); } });
  watchStatus();
  tryStream(c, token);
}

/** Échec d'un flux (`reason` : clé de REASONS) : essaie les alternatives de la chaîne avant d'afficher « Chaîne indisponible ». */
export function failover(c, token, reason) {
  if (token !== tv.playToken) return;
  clearTimeout(tv.stallTimer);
  if (tv.attempt + 1 < sourcesOf(c).length) {
    tv.attempt += 1;
    tryStream(c, token);
    return;
  }
  playFail(token, reason, c);
}

/**
 * Veille la lecture d'un direct : si l'image n'avance plus pendant ~16 s, relance le chargement (hls.js : startLoad,
 * natif : rechargement de la source), puis bascule sur l'alternative suivante si ça ne repart pas.
 */
function watchLive(fail, restart) {
  clearInterval(tv.watchTimer);
  let last = -1;
  let strikes = 0;
  tv.watchTimer = setInterval(() => {
    if (videoEl.paused || videoEl.ended || videoEl.seeking) { strikes = 0; return; }
    if (videoEl.currentTime === last) strikes += 1; else { strikes = 0; last = videoEl.currentTime; }
    if (strikes === 2) restart();
    else if (strikes >= 4) { clearInterval(tv.watchTimer); fail('network'); }
  }, 8000);
}

function tryStream(c, token) {
  destroyStream();
  perrEl.hidden = true;
  setStatus({ type: 'connect' });
  // Index de la source tentée : sourcesOf() renvoie de nouveaux objets à chaque appel, on ne peut pas comparer par identité.
  const idx = tv.attempt;
  const cur = sourcesOf(c)[idx];
  // `r` : clé de REASONS, ou une erreur mpv / du plugin natif (interprétée par reasonOfExternal).
  const fail = (r) => failover(c, token, typeof r === 'string' ? r : reasonOfExternal(r));
  const web = !externalKind();
  videoEl.onplaying = () => { clearTimeout(tv.stallTimer); perrEl.hidden = true; };
  videoEl.onerror = () => {
    const code = videoEl.error ? videoEl.error.code : 0;
    fail(code === 2 ? 'network' : code === 3 || code === 4 ? 'format' : 'read');
  };
  tv.stallTimer = setTimeout(() => fail('network'), 20000);
  // Les playlists HLS sont lues directement (hls.js ou le lecteur natif) : jamais via le cache JSON du client.
  // Sans signature (serveur sans proxy HLS) : l'URL du flux elle-même, lue directement.
  const proxied = cur.sig ? tvHlsUrl(cur) : cur.url;
  const native = (src) => {
    videoEl.src = src;
    videoEl.play().catch(() => {});
    watchLive(fail, () => { const t = videoEl.src; videoEl.src = t; videoEl.load(); videoEl.play().catch(() => {}); });
  };
  // Coque Windows (mpv) et application Android (lecteur natif) : l'URL du proxy HLS signée, ou le flux lui-même sans proxy.
  const kind = externalKind();
  const external = kind ? proxied : '';
  const viaPage = () => {
    if (token !== tv.playToken || tv.attempt !== idx) return;
    pageStream();
  };
  const pageStream = () => {
  if (isDirectFile(cur.url)) {
    videoEl.src = cur.url;
    videoEl.play().catch(() => {});
  } else {
    loadHls().then((H) => {
      if (token !== tv.playToken || tv.attempt !== idx) return;
      if (H && H.isSupported()) {
        const h = new H({
          lowLatencyMode: false,
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 10,
          manifestLoadingMaxRetry: 4,
          levelLoadingMaxRetry: 6,
          fragLoadingMaxRetry: 6,
          maxBufferLength: 20,
        });
        tv.hls = h;
        let net = 0;
        let media = 0;
        h.on(H.Events.FRAG_LOADED, () => { net = 0; media = 0; });
        h.on(H.Events.ERROR, (_e, d) => {
          if (!d || !d.fatal) return;
          if (d.type === H.ErrorTypes.NETWORK_ERROR && net++ < 3) h.startLoad();
          else if (d.type === H.ErrorTypes.MEDIA_ERROR && media++ < 2) h.recoverMediaError();
          else fail(reasonOfHls(d, H.ErrorTypes, web));
        });
        h.on(H.Events.MANIFEST_PARSED, () => { videoEl.play().catch(() => {}); });
        h.loadSource(proxied);
        h.attachMedia(videoEl);
        watchLive(fail, () => { try { h.startLoad(); } catch (_) { /* ignoré */ } });
      } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
        native(proxied); // Safari / iOS : HLS natif
      } else {
        fail('format'); // hls.js absent et pas de HLS natif : le flux ne peut pas être lu dans cette page
      }
    }).catch(() => {
      if (token === tv.playToken && videoEl.canPlayType('application/vnd.apple.mpegurl')) native(proxied);
      else fail('network');
    });
  }
  };
  if (!external) { pageStream(); return; }
  startExternal(kind, external, { title: c.name, container: playerEl, onError: fail, onClosed: () => closePlayer() }).then((ok) => {
    if (token !== tv.playToken || tv.attempt !== idx) { if (playerEl.hidden) stopExternal(); return; }
    if (ok) clearTimeout(tv.stallTimer); else viaPage();
  }).catch(() => viaPage());
}

// ---------- Panneau « Infos » ----------

/** Ouvre ou ferme le panneau d'infos (bouton i, touche I, re-clic). Il remplace les autres panneaux. */
export function toggleInfo(on) {
  tv.info = on == null ? !tv.info : !!on;
  if (tv.info) { panel = null; panelEl.hidden = true; }
  infoEl.hidden = !tv.info;
  setAttr('[data-pinfo]', 'aria-pressed', String(tv.info));
  if (tv.info) renderInfo();
  wakeUi();
}

function renderInfo() {
  const c = curChannel();
  if (!c || !tv.info) return;
  const m = infoModel(c, tv.epg.get(epgKey(c)) || [], Math.floor(Date.now() / 1000), ctl().tech());
  const logo = '<span class="pi-logo">' + (m.logo ? '<img src="' + esc(m.logo) + '" alt="">' : '<b>' + esc(m.name.slice(0, 3)) + '</b>') + '</span>';
  const now = m.now
    ? '<div class="pi-now"><p class="pi-k">En cours · ' + fmtHM(m.now.start) + ' – ' + fmtHM(m.now.stop) + ' · ' + m.now.left + ' min restantes</p>' +
      '<h3 class="pi-title">' + esc(m.now.title) + '</h3>' +
      '<span class="progress" aria-hidden="true"><span style="width:' + m.now.pct + '%"></span></span>' +
      (m.now.desc ? '<p class="pi-desc">' + esc(m.now.desc) + '</p>' : '') + '</div>'
    : '<div class="pi-now"><p class="pi-k">Programme</p><p class="pi-title">Programme non communiqué</p></div>';
  const next = m.next.length
    ? '<div class="pi-next"><p class="pi-k">Ensuite</p><ol>' + m.next.map((p) => '<li><span class="pi-h">' + fmtHM(p.start) + '</span><span>' + esc(p.title) + '</span></li>').join('') + '</ol></div>'
    : '';
  const tech = m.tech.length
    ? '<dl class="pi-tech">' + m.tech.map(([k, v]) => '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>').join('') + '</dl>'
    : '';
  setHtml(infoEl, '<div class="pi-head">' + logo + '<div><p class="pi-num">' + (m.number ? 'Chaîne ' + esc(m.number) : 'Chaîne') + '</p>' +
    '<h2 class="pi-name">' + esc(m.name) + '</h2></div><button type="button" class="lp-btn" data-pinfo-close aria-label="Fermer les infos">&times;</button></div>' +
    now + next + tech);
}

// ---------- Panneaux de choix (pistes, qualité, chaînes) ----------

function panelContent(name) {
  if (name === 'audio') return { title: 'Piste audio', kind: 'audio', items: ctl().audio() };
  if (name === 'sub') return { title: 'Sous-titres', kind: 'sub', items: ctl().subs() };
  if (name === 'quality') return { title: 'Qualité', kind: 'quality', items: ctl().levels() };
  const list = tv.play ? tv.play.list : [];
  return {
    title: 'Chaînes',
    kind: 'chan',
    items: list.map((ch, i) => ({ id: String(i), n: channelNumber(ch) ? String(channelNumber(ch)) : '', label: ch.name || '', selected: i === tv.play.idx })),
  };
}

function renderPanel() {
  if (!panel) { panelEl.hidden = true; return; }
  const { title, kind, items } = panelContent(panel);
  panelEl.innerHTML = '<div class="pp-head"><h2>' + esc(title) + '</h2><button type="button" class="lp-btn" data-pclose-panel aria-label="Fermer">&times;</button></div>' +
    '<ul class="pp-list">' + items.map((o) => '<li><button type="button" class="pp-item" data-pitem="' + kind + '" data-pid="' + esc(o.id) + '" aria-pressed="' + (o.selected ? 'true' : 'false') + '">' +
      (o.n ? '<span class="pp-n">' + esc(o.n) + '</span>' : '') + '<span>' + esc(o.label) + '</span></button></li>').join('') + '</ul>';
  panelEl.hidden = false;
  const cur = panelEl.querySelector('[aria-pressed="true"]');
  if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
}

function openPanel(name) {
  if (panel === name) { closePanel(); return; }
  panel = name;
  tv.info = false;
  infoEl.hidden = true;
  setAttr('[data-pinfo]', 'aria-pressed', 'false');
  renderPanel();
  refreshBar();
  wakeUi();
}

function closePanel() {
  panel = null;
  panelEl.hidden = true;
  wakeUi();
}

function pickItem(b) {
  const kind = b.dataset.pitem;
  const id = b.dataset.pid;
  if (kind === 'chan') {
    closePanel();
    if (tv.play) { tv.play.idx = Number(id); startStream(); }
    return;
  }
  const c = ctl();
  if (kind === 'audio') c.setAudio(id);
  else if (kind === 'sub') c.setSub(id);
  else if (kind === 'quality') c.setLevel(id);
  closePanel();
  refreshBar();
}

// ---------- Barre de contrôle ----------

/** Met la barre à jour : icônes selon l'état, boutons présents seulement si la sortie sait les servir, badge DIRECT. */
function refreshBar() {
  if (playerEl.hidden) return;
  const c = ctl();
  const paused = c.paused();
  setIcon('[data-pplay]', paused ? ICON.play : ICON.pause);
  setAttr('[data-pplay]', 'aria-label', paused ? 'Lecture' : 'Pause');

  const muted = c.muted() || c.volume() === 0;
  setHidden('.lp-vol', !c.canVolume);
  setIcon('[data-pmute]', muted ? ICON.mute : ICON.vol);
  setAttr('[data-pmute]', 'aria-label', muted ? 'Activer le son' : 'Couper le son');
  const slider = $('[data-pvol]');
  if (slider && document.activeElement !== slider) slider.value = String(Math.round(c.volume() * 100));

  setHidden('[data-ptrack="audio"]', c.audio().length < 2);
  setHidden('[data-ptrack="sub"]', c.subs().length < 1);
  setHidden('[data-ptrack="quality"]', c.levels().length < 2);
  setHidden('[data-ppip]', !c.canPip);
  setAttr('[data-ppip]', 'aria-pressed', String(!!c.pip()));
  setHidden('[data-pfull]', !c.canFullscreen);
  const fs = c.fullscreen();
  setIcon('[data-pfull]', fs ? ICON.fullExit : ICON.full);
  setAttr('[data-pfull]', 'aria-label', fs ? 'Quitter le plein écran' : 'Plein écran');

  const ch = curChannel();
  chnameEl.textContent = ch ? ch.name : '';
  liveEl.hidden = !liveBadge(tv.status, paused);
  armIdle();
}

function togglePause() {
  ctl().togglePause();
  refreshBar();
}

function toggleMute() {
  const c = ctl();
  if (!c.canVolume) return;
  c.setMuted(!c.muted());
  refreshBar();
}

function toggleFullscreen() {
  const c = ctl();
  if (c.canFullscreen) c.setFullscreen(!c.fullscreen());
  refreshBar();
}

function togglePip() {
  const c = ctl();
  if (c.canPip) c.setPip(!c.pip());
  refreshBar();
}

// ---------- Ouverture, fermeture, zapping ----------

export function openPlayer(c, list, opener) {
  const l = list && list.some((x) => x.id === c.id) ? list : [c];
  tv.play = { list: l, idx: l.findIndex((x) => x.id === c.id) };
  tv.opener = opener || document.activeElement;
  stopPreview();
  tv.info = false;
  panel = null;
  infoEl.hidden = true;
  panelEl.hidden = true;
  playerEl.hidden = false;
  document.body.classList.add('modal-open');
  startStream();
  const cb = playerEl.querySelector('[data-pclose]');
  if (cb) cb.focus({ preventScroll: true });
}

export function closePlayer(silent) {
  if (playerEl.hidden) return;
  leaveFullscreen();
  tv.playToken++;
  destroyStream();
  clearInterval(tv.statusTimer);
  clearTimeout(idleTimer);
  idleTimer = 0;
  tv.info = false;
  panel = null;
  infoEl.hidden = true;
  panelEl.hidden = true;
  playerEl.hidden = true;
  playerEl.classList.remove('is-idle');
  setStatus({ type: 'stop' });
  perrEl.hidden = true;
  document.body.classList.remove('modal-open');
  const t = tv.opener;
  tv.opener = null;
  if (!silent && t && t.isConnected && t.focus) t.focus({ preventScroll: true });
}

export function zap(delta) {
  if (!tv.play) return;
  const n = tv.play.list.length;
  tv.play.idx = (tv.play.idx + delta + n) % n;
  startStream();
}

/** Clavier du lecteur (appelé par events.js avant la navigation). Renvoie true si la touche est traitée. */
export function playerKey(e) {
  if (playerEl.hidden) return false;
  const act = tvKeyAction(e.key);
  wakeUi();
  if (!act) return false; // flèches gauche et droite, Tab : navigation entre boutons
  if (act === 'escape') {
    if (panel) closePanel();
    else if (tv.info) toggleInfo(false);
    else if (ctl().fullscreen()) toggleFullscreen();
    else closePlayer();
    return true;
  }
  if (act === 'prev') zap(-1);
  else if (act === 'next') zap(1);
  else if (act === 'info') toggleInfo();
  else if (act === 'toggle') togglePause();
  else if (act === 'mute') toggleMute();
  else if (act === 'fullscreen') toggleFullscreen();
  return true;
}

const CLICKS = [
  ['[data-pclose]', () => closePlayer()],
  ['[data-pnext]', () => zap(1)],
  ['[data-pprev]', () => zap(-1)],
  ['[data-pinfo]', () => toggleInfo()],
  ['[data-pinfo-close]', () => toggleInfo(false)],
  ['[data-pplay]', () => togglePause()],
  ['[data-pmute]', () => toggleMute()],
  ['[data-pfull]', () => toggleFullscreen()],
  ['[data-ppip]', () => togglePip()],
  ['[data-ptrack]', (b) => openPanel(b.dataset.ptrack)],
  ['[data-plist]', () => openPanel('list')],
  ['[data-pclose-panel]', () => closePanel()],
  ['[data-pitem]', (b) => pickItem(b)],
];

playerEl.addEventListener('click', (e) => {
  if (!(e.target instanceof Element)) return;
  for (const [sel, run] of CLICKS) {
    const b = e.target.closest(sel);
    if (!b) continue;
    e.preventDefault();
    wakeUi();
    run(b);
    return;
  }
});
playerEl.addEventListener('input', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || !t.matches('[data-pvol]')) return;
  wakeUi();
  ctl().setVolume(Number(t.value) / 100);
});
playerEl.addEventListener('pointermove', () => wakeUi());
playerEl.addEventListener('pointerdown', () => wakeUi());
playerEl.addEventListener('focusin', () => wakeUi());
document.addEventListener('fullscreenchange', () => refreshBar());
