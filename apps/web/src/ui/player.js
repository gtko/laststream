/* Port du prototype (voir tools/port-prototype.mjs). */
import { tvHlsUrl } from '../data/lt';
import { stopPreview } from './preview.js';
import { externalKind, externalSample, startExternal, stopExternal } from './tvExternal.js';
import { bannerEl, ensureEpg, fmtHM, nowNext, perrEl, playerEl, setChannelDown, statusEl, tv, videoEl } from './tv.js';
import { reasonOfExternal, reasonOfHls, reduceTvStatus, renderTvStatus, statusView } from './tvStatus.js';
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

export function destroyStream() {
  clearTimeout(tv.stallTimer);
  clearInterval(tv.watchTimer);
  stopExternal();
  if (tv.hls) { try { tv.hls.destroy(); } catch (_) { /* déjà détruit */ } tv.hls = null; }
  videoEl.removeAttribute('src');
  try { videoEl.load(); } catch (_) { /* ignoré */ }
}

export function showBanner(sticky) {
  bannerEl.classList.add('is-on');
  clearTimeout(tv.bannerTimer);
  if (!tv.info && !sticky) tv.bannerTimer = setTimeout(() => bannerEl.classList.remove('is-on'), 4000);
}

export function updateBanner() {
  const c = curChannel();
  if (!c) return;
  const now = Math.floor(Date.now() / 1000);
  const nn = nowNext(c, now);
  const pct = nn.cur ? Math.max(0, Math.min(100, Math.round(((now - nn.cur.start) / (nn.cur.stop - nn.cur.start)) * 100))) : 0;
  bannerEl.innerHTML = '<span class="pb-logo">' + (c.logo ? '<img src="' + esc(c.logo) + '" alt="">' : '<b>' + esc(c.name.slice(0, 3)) + '</b>') + '</span>' +
    '<span class="pb-text"><span class="pb-ch">' + esc(c.name) + '</span>' +
    (nn.cur ? '<span class="pb-now"><strong>En cours</strong> ' + esc(nn.cur.title) + ' · ' + fmtHM(nn.cur.start) + ' – ' + fmtHM(nn.cur.stop) + '</span><span class="progress pb-prog" aria-hidden="true"><span style="width:' + pct + '%"></span></span>' : '<span class="pb-now">Programme non communiqué</span>') +
    (nn.next ? '<span class="pb-next">Ensuite : ' + esc(nn.next.title) + ' · ' + fmtHM(nn.next.start) + '</span>' : '') + '</span>';
}

/** Met à jour le signal d'état du lecteur (pastille en haut) à partir d'un événement de tvStatus.js. */
function setStatus(ev) {
  tv.status = reduceTvStatus(tv.status, ev);
  renderTvStatus(statusEl, statusView(tv.status));
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
  showBanner();
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

export function openPlayer(c, list, opener) {
  const l = list && list.some((x) => x.id === c.id) ? list : [c];
  tv.play = { list: l, idx: l.findIndex((x) => x.id === c.id) };
  tv.opener = opener || document.activeElement;
  stopPreview();
  playerEl.hidden = false;
  document.body.classList.add('modal-open');
  startStream();
  const cb = playerEl.querySelector('[data-pclose]');
  if (cb) cb.focus({ preventScroll: true });
}

export function closePlayer(silent) {
  if (playerEl.hidden) return;
  tv.playToken++;
  destroyStream();
  clearInterval(tv.statusTimer);
  setStatus({ type: 'stop' });
  clearTimeout(tv.bannerTimer);
  playerEl.hidden = true;
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

export function playerKey(e) {
  if (playerEl.hidden) return false;
  const k = e.key;
  if (k === 'Escape' || k === 'Backspace') { closePlayer(); return true; }
  if (k === 'ArrowUp' || k === 'PageUp' || k === 'ChannelUp') { zap(-1); return true; }
  if (k === 'ArrowDown' || k === 'PageDown' || k === 'ChannelDown') { zap(1); return true; }
  if (k === 'i' || k === 'I') {
    tv.info = !tv.info;
    if (tv.info) { updateBanner(); showBanner(true); } else { bannerEl.classList.remove('is-on'); }
    return true;
  }
  if (k === ' ') { if (videoEl.paused) videoEl.play().catch(() => {}); else videoEl.pause(); return true; }
  if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Tab') return false; // navigation entre boutons
  showBanner();
  return false;
}
playerEl.addEventListener('mousemove', () => { updateBanner(); showBanner(); });
