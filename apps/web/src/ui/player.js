/* Port du prototype (voir tools/port-prototype.mjs). */
import { tvHlsUrl } from '../data/lt';
import { stopPreview } from './preview.js';
import { externalKind, startExternal, stopExternal } from './tvExternal.js';
import { bannerEl, ensureEpg, fmtHM, nowNext, perrEl, playerEl, tv, videoEl } from './tv.js';
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

export function playFail(token) {
  if (token !== tv.playToken) return;
  clearTimeout(tv.stallTimer);
  perrEl.hidden = false;
  const b = perrEl.querySelector('[data-pnext]');
  if (b) b.focus();
}

const sourcesOf = (c) => [{ url: c.url, sig: c.sig }].concat(c.alternatives || []);
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
  tryStream(c, token);
}

/** Échec d'un flux : essaie les alternatives de la chaîne avant d'afficher « Cette chaîne ne répond pas ». */
export function failover(c, token) {
  if (token !== tv.playToken) return;
  clearTimeout(tv.stallTimer);
  if (tv.attempt + 1 < sourcesOf(c).length) {
    tv.attempt += 1;
    tryStream(c, token);
    return;
  }
  playFail(token);
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
    else if (strikes >= 4) { clearInterval(tv.watchTimer); fail(); }
  }, 8000);
}

function tryStream(c, token) {
  destroyStream();
  perrEl.hidden = true;
  // Index de la source tentée : sourcesOf() renvoie de nouveaux objets à chaque appel, on ne peut pas comparer par identité.
  const idx = tv.attempt;
  const cur = sourcesOf(c)[idx];
  const fail = () => failover(c, token);
  videoEl.onplaying = () => { clearTimeout(tv.stallTimer); perrEl.hidden = true; };
  videoEl.onerror = fail;
  tv.stallTimer = setTimeout(fail, 20000);
  // Les playlists HLS sont lues directement (hls.js ou le lecteur natif) : jamais via le cache JSON du client.
  const proxied = cur.sig ? tvHlsUrl(cur) : '';
  const native = (src) => {
    videoEl.src = src;
    videoEl.play().catch(() => {});
    watchLive(fail, () => { const t = videoEl.src; videoEl.src = t; videoEl.load(); videoEl.play().catch(() => {}); });
  };
  // Coque Windows (mpv) et application Android (lecteur natif) : on leur passe l'URL du proxy HLS signée.
  const kind = externalKind();
  const external = kind ? (proxied || (isDirectFile(cur.url) ? cur.url : '')) : '';
  const viaPage = () => {
    if (token !== tv.playToken || tv.attempt !== idx) return;
    pageStream();
  };
  const pageStream = () => {
  if (isDirectFile(cur.url)) {
    videoEl.src = cur.url;
    videoEl.play().catch(() => {});
  } else if (!proxied) {
    fail();
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
          else fail();
        });
        h.on(H.Events.MANIFEST_PARSED, () => { videoEl.play().catch(() => {}); });
        h.loadSource(proxied);
        h.attachMedia(videoEl);
        watchLive(fail, () => { try { h.startLoad(); } catch (_) { /* ignoré */ } });
      } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
        native(proxied); // Safari / iOS : HLS natif
      } else {
        fail();
      }
    }).catch(() => {
      if (token === tv.playToken && videoEl.canPlayType('application/vnd.apple.mpegurl')) native(proxied);
      else fail();
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
