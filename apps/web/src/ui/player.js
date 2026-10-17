/* Port du prototype (voir tools/port-prototype.mjs). */
import { tvHlsUrl } from '../data/lt';
import { stopPreview } from './preview.js';
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

export function startStream() {
  const c = curChannel();
  if (!c) return;
  const token = ++tv.playToken;
  destroyStream();
  perrEl.hidden = true;
  store('ls_tv_last', { id: c.id, name: c.name, logo: c.logo, group: c.group, cat: c.cat, source: c.source, fast: c.fast, url: c.url, epgId: c.epgId, flaky: !!c.flaky, sig: c.sig });
  updateBanner();
  showBanner();
  ensureEpg([c]).then(() => { if (token === tv.playToken) { updateBanner(); } });
  videoEl.onplaying = () => { clearTimeout(tv.stallTimer); perrEl.hidden = true; };
  videoEl.onerror = () => playFail(token);
  tv.stallTimer = setTimeout(() => playFail(token), 20000);
  const proxied = c.sig ? tvHlsUrl(c) : '';
  if (!proxied && !/\.(mp4|webm|mkv|ts)(\?|$)/i.test(c.url)) {
    playFail(token);
  } else if (/\.(mp4|webm|mkv|ts)(\?|$)/i.test(c.url)) {
    videoEl.src = c.url;
    videoEl.play().catch(() => {});
  } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    videoEl.src = proxied;
    videoEl.play().catch(() => {});
  } else {
    loadHls().then((H) => {
      if (token !== tv.playToken) return;
      if (!H || !H.isSupported()) { playFail(token); return; }
      const h = new H({ maxBufferLength: 20 });
      tv.hls = h;
      h.on(H.Events.ERROR, (_e, d) => { if (d && d.fatal) playFail(token); });
      h.on(H.Events.MANIFEST_PARSED, () => { videoEl.play().catch(() => {}); });
      h.loadSource(proxied);
      h.attachMedia(videoEl);
    }).catch(() => playFail(token));
  }
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
