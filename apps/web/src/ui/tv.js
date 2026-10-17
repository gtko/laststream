/* Port du prototype (voir tools/port-prototype.mjs). */
import { tvChannels, tvEpg, tvImport } from '../data/lt';
import { detailEl } from './dom.js';
import { teardownFiche } from './fiche.js';
import { row, svcError, topBar } from './fragments.js';
import { ICON } from './icons.js';
import { state } from './state.js';
import { esc, store } from './util.js';

export const tv = {
  channels: null, loading: null, user: [], epg: new Map(), epgReq: new Set(), w0: 0,
  cat: 'Toutes', showFlaky: false, list: [], shown: 0, homeList: [], play: null,
  hls: null, hlsPromise: null, bannerTimer: null, stallTimer: null, playToken: 0, info: false, opener: null, io: null,
};
export const TV_CATS = ['Toutes', 'Favoris', 'Info', 'Sport', 'Cinéma', 'Jeunesse', 'Musique', 'Divertissement', 'Documentaires', 'FAST', 'Ma playlist'];
export const PX_MIN = 160 / 30; // 30 min = 160 px
export const EPG_H = 6;
export const EPG_CH_W = 220;
export const playerEl = document.getElementById('player');
export const videoEl = document.getElementById('player-video');
export const bannerEl = document.getElementById('player-banner');
export const perrEl = document.getElementById('player-error');
export const getFavs = () => store('ls_tv_fav') || [];
export const allChannels = () => (tv.channels || []).concat(tv.user);
export const epgKey = (c) => (c.source === 'user' ? c.epgId || '' : c.id);
export const fmtHM = (sec) => new Date(sec * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

export function tvWindow() {
  const now = Math.floor(Date.now() / 1000);
  const w0 = Math.floor((now - 1800) / 1800) * 1800;
  if (!tv.w0 || w0 - tv.w0 >= 3600) {
    if (tv.w0) { tv.epg.clear(); tv.epgReq.clear(); }
    tv.w0 = w0;
  }
  return tv.w0;
}

export function loadUserPlaylist() {
  const cfg = store('ls_tv_playlist');
  if (!cfg) { tv.user = []; return Promise.resolve(); }
  return tvImport(cfg).then((j) => { tv.user = j.channels || []; }).catch(() => { tv.user = []; });
}

export function loadTvChannels() {
  if (!tv.loading) {
    tv.loading = (async () => {
      tv.channels = await tvChannels();
      await loadUserPlaylist();
      return tv.channels;
    })();
    tv.loading.catch(() => { tv.loading = null; });
  }
  return tv.loading;
}

export async function ensureEpg(chs) {
  const w0 = tvWindow();
  const keys = Array.from(new Set(chs.map(epgKey).filter((k) => k && !tv.epgReq.has(k))));
  keys.forEach((k) => tv.epgReq.add(k));
  const jobs = [];
  for (let i = 0; i < keys.length; i += 40) {
    const part = keys.slice(i, i + 40);
    jobs.push(tvEpg(part, w0, w0 + EPG_H * 3600)
      .then((list) => {
        part.forEach((k) => { if (!tv.epg.has(k)) tv.epg.set(k, []); });
        list.forEach((p) => tv.epg.get(p.channelId) && tv.epg.get(p.channelId).push(p));
      }).catch(() => { part.forEach((k) => tv.epgReq.delete(k)); }));
  }
  await Promise.all(jobs);
}

export function nowNext(c, now) {
  const arr = tv.epg.get(epgKey(c)) || [];
  const cur = arr.find((p) => p.start <= now && now < p.stop) || null;
  const next = arr.find((p) => p.start >= (cur ? cur.stop : now)) || null;
  return { cur, next };
}

// Rangée d'accueil « En direct maintenant »
export function liveTile(c, nn, now) {
  const pct = Math.max(0, Math.min(100, Math.round(((now - nn.cur.start) / (nn.cur.stop - nn.cur.start)) * 100)));
  return '<button type="button" class="live-tile" data-tvplay="' + esc(c.id) + '" data-tvctx="home" aria-label="' + esc(c.name + ', en direct : ' + nn.cur.title + (nn.next ? ', ensuite : ' + nn.next.title : '')) + '">' +
    '<span class="lt-top"><span class="lt-logo">' + (c.logo ? '<img src="' + esc(c.logo) + '" alt="" loading="lazy" decoding="async">' : '<b>' + esc(c.name.slice(0, 3)) + '</b>') + '</span>' +
    '<span class="lt-name">' + esc(c.name) + '</span><span class="lt-live" aria-hidden="true">En direct</span></span>' +
    '<span class="lt-title" aria-hidden="true">' + esc(nn.cur.title) + '</span>' +
    '<span class="lt-next" aria-hidden="true">' + (nn.next ? 'Ensuite : ' + esc(nn.next.title) : '&nbsp;') + '</span>' +
    '<span class="progress" aria-hidden="true"><span style="width:' + pct + '%"></span></span></button>';
}

export async function renderLive() {
  try {
    if (state.status !== 'ready' || !document.getElementById('live-slot')) return;
    const chs = (await loadTvChannels()).filter((c) => !c.flaky);
    const pool = chs.filter((c) => !c.fast).slice(0, 24).concat(chs.filter((c) => c.fast).slice(0, 12));
    await ensureEpg(pool);
    const now = Math.floor(Date.now() / 1000);
    const live = pool.map((c) => ({ c, nn: nowNext(c, now) })).filter((x) => x.nn.cur);
    const pick = live.filter((x) => !x.c.fast).slice(0, 8).concat(live.filter((x) => x.c.fast).slice(0, 4));
    const slot = document.getElementById('live-slot');
    if (!slot || !pick.length) return;
    tv.homeList = pick.map((x) => x.c);
    slot.innerHTML = '<section class="row-section" id="direct" aria-labelledby="h-direct"><h2 class="row-title" id="h-direct">En direct maintenant ' +
      '<a class="row-link" href="#/tv-live" data-tvlive>Guide TV</a></h2>' + row(pick.map((x) => liveTile(x.c, x.nn, now)).join('')) + '</section>';
  } catch (_) { /* rangée absente */ }
}

// Page #/tv-live
export function tvFilter() {
  const favs = getFavs();
  let l = allChannels().filter((c) => (c.flaky ? tv.showFlaky : true));
  const cat = tv.cat;
  if (cat === 'Favoris') l = l.filter((c) => favs.includes(c.id));
  else if (cat === 'FAST') l = l.filter((c) => c.fast);
  else if (cat === 'Ma playlist') l = l.filter((c) => c.source === 'user');
  else if (cat !== 'Toutes') l = l.filter((c) => c.source !== 'user' && c.cat === cat);
  if (cat === 'Toutes') l = l.slice().sort((a, b) => (favs.includes(b.id) ? 1 : 0) - (favs.includes(a.id) ? 1 : 0));
  return l;
}

export function catCount(cat) {
  const prev = tv.cat;
  tv.cat = cat;
  const n = tvFilter().length;
  tv.cat = prev;
  return n;
}

export function catsHTML() {
  const flaky = allChannels().filter((c) => c.flaky).length;
  return TV_CATS.map((c) => '<div data-nav><button type="button" class="tv-cat" data-tvcat="' + esc(c) + '" aria-pressed="' + (c === tv.cat) + '">' + esc(c) +
    ' <span>' + catCount(c) + '</span></button></div>').join('') +
    (flaky ? '<div data-nav><button type="button" class="tv-cat tv-flaky" data-tvflaky aria-pressed="' + tv.showFlaky + '">Chaînes instables <span>' + flaky + '</span></button></div>' : '');
}

export function settingsHTML() {
  const cfg = store('ls_tv_playlist') || { type: 'm3u' };
  const x = cfg.type === 'xtream';
  const v = (k) => esc(cfg[k] || '');
  return '<form id="tv-form" class="tv-form" autocomplete="off"><h2 class="f-sub">Ma playlist</h2>' +
    '<div class="tv-radios" role="radiogroup" aria-label="Type de playlist"><label><input type="radio" name="ttype" value="m3u"' + (x ? '' : ' checked') + '> Lien M3U</label>' +
    '<label><input type="radio" name="ttype" value="xtream"' + (x ? ' checked' : '') + '> Xtream Codes</label></div>' +
    '<div data-ttype="m3u"' + (x ? ' hidden' : '') + '><label class="tv-field">URL de la playlist M3U<input type="url" name="url" placeholder="https://exemple.fr/playlist.m3u" value="' + v('url') + '"></label></div>' +
    '<div data-ttype="xtream"' + (x ? '' : ' hidden') + '><label class="tv-field">Serveur<input type="text" name="server" placeholder="http://serveur:8080" value="' + v('server') + '"></label>' +
    '<label class="tv-field">Identifiant<input type="text" name="username" value="' + v('username') + '"></label>' +
    '<label class="tv-field">Mot de passe<input type="password" name="password" value="' + v('password') + '"></label></div>' +
    '<div class="tv-form-actions"><button type="button" class="btn btn-ghost" data-tvtest>Tester</button><button type="submit" class="btn btn-primary">Enregistrer et charger</button>' +
    '<button type="button" class="btn btn-ghost" data-tvclear>Retirer ma playlist</button></div>' +
    '<p class="tv-form-msg" id="tv-form-msg" role="status"></p>' +
    '<p class="tv-form-note">Enregistrée uniquement dans ce navigateur. Les identifiants sont transmis à ton serveur local pour lire la playlist, sans être enregistrés ni journalisés.</p></form>';
}

export function tvPageHTML() {
  const last = store('ls_tv_last');
  return topBar(false) +
    '<article class="tv-page" aria-labelledby="tv-title"><header class="tv-head"><div><p class="svc-eyebrow">Chaînes gratuites, FAST et ta playlist</p>' +
    '<h1 class="svc-title" id="tv-title" tabindex="-1">TV en direct</h1></div><div class="tv-head-actions" data-nav>' +
    (last ? '<button type="button" class="btn btn-primary" data-tvplay="' + esc(last.id) + '">' + ICON.play + '<span>Reprendre la dernière chaîne</span></button>' : '') +
    '<button type="button" class="btn btn-ghost" data-tvsettings aria-expanded="false">' + ICON.gear + '<span>Ma playlist</span></button></div></header>' +
    '<div class="tv-body"><nav class="tv-cats" id="tv-cats" aria-label="Catégories">' + catsHTML() + '</nav><div class="tv-main">' +
    '<div id="tv-settings" class="tv-settings glass" hidden>' + settingsHTML() + '</div>' +
    '<div class="tv-detail glass" id="tv-detail" aria-live="polite"><p class="tv-detail-hint">Sélectionne un programme pour voir le détail. Entrée lance la chaîne.</p></div>' +
    '<div class="epg" id="epg"></div></div></div></article>';
}

export function epgShell() {
  const w0 = tvWindow();
  const total = EPG_H * 60 * PX_MIN;
  let slots = '';
  for (let i = 0; i < EPG_H * 2; i++) slots += '<span class="epg-slot" style="width:' + 30 * PX_MIN + 'px">' + fmtHM(w0 + i * 1800) + '</span>';
  const nowPx = ((Math.floor(Date.now() / 1000) - w0) / 60) * PX_MIN;
  return '<div class="epg-scroll" id="epg-scroll"><div class="epg-inner" style="width:' + (EPG_CH_W + total) + 'px">' +
    '<div class="epg-times"><div class="epg-corner">Chaîne</div><div class="epg-slots">' + slots + '</div></div>' +
    '<div id="epg-rows"></div><div class="epg-now" id="epg-now" style="left:' + (EPG_CH_W + nowPx) + 'px" aria-hidden="true"></div></div></div>' +
    '<div class="epg-more" id="epg-more"></div>';
}

export function epgRowHTML(c) {
  const fav = getFavs().includes(c.id);
  return '<div class="epg-row" data-nav data-chid="' + esc(c.id) + '"><div class="epg-chcol">' +
    '<button type="button" class="epg-ch" data-tvplay="' + esc(c.id) + '" data-tvctx="page" aria-label="Regarder ' + esc(c.name) + '">' +
    '<span class="epg-logo">' + (c.logo ? '<img src="' + esc(c.logo) + '" alt="" loading="lazy" decoding="async">' : '<b>' + esc(c.name.slice(0, 3)) + '</b>') + '</span>' +
    '<span class="epg-name">' + esc(c.name) + (c.flaky ? ' <em>instable</em>' : '') + '</span></button>' +
    '<button type="button" class="epg-fav" data-tvfav="' + esc(c.id) + '" aria-pressed="' + fav + '" aria-label="' + (fav ? 'Retirer des favoris : ' : 'Ajouter aux favoris : ') + esc(c.name) + '">' + (fav ? ICON.starOn : ICON.star) + '</button></div>' +
    '<div class="epg-line" style="width:' + EPG_H * 60 * PX_MIN + 'px"><span class="epg-load">Chargement…</span></div></div>';
}

export function fillEpgRow(c) {
  const line = detailEl.querySelector('.epg-row[data-chid="' + c.id.replace(/"/g, '\\"') + '"] .epg-line');
  if (!line) return;
  const w0 = tv.w0;
  const w1 = w0 + EPG_H * 3600;
  const now = Math.floor(Date.now() / 1000);
  const arr = tv.epg.get(epgKey(c)) || [];
  const cells = arr.filter((p) => p.stop > w0 && p.start < w1).map((p) => {
    const s = Math.max(p.start, w0);
    const e = Math.min(p.stop, w1);
    const left = ((s - w0) / 60) * PX_MIN;
    const width = Math.max(2, ((e - s) / 60) * PX_MIN - 3);
    const isNow = p.start <= now && now < p.stop;
    return '<button type="button" class="epg-cell' + (isNow ? ' is-now' : '') + '" style="left:' + left + 'px;width:' + width + 'px" data-tvprog="' + esc(c.id) + '|' + p.start +
      '" aria-label="' + esc(p.title + ', ' + fmtHM(p.start) + ' à ' + fmtHM(p.stop) + (isNow ? ', en cours' : '')) + '"><span class="ec-t">' + esc(p.title) + '</span><span class="ec-h">' + fmtHM(p.start) + '</span></button>';
  });
  line.innerHTML = cells.length ? cells.join('') :
    '<button type="button" class="epg-cell epg-none" style="left:0;width:' + (EPG_H * 60 * PX_MIN - 3) + 'px" data-tvplay="' + esc(c.id) + '" data-tvctx="page"><span class="ec-t">Programme indisponible</span><span class="ec-h">Regarder en direct</span></button>';
}

export function appendRows() {
  const box = detailEl.querySelector('#epg-rows');
  const more = detailEl.querySelector('#epg-more');
  if (!box) return;
  const batch = tv.list.slice(tv.shown, tv.shown + 40);
  tv.shown += batch.length;
  box.insertAdjacentHTML('beforeend', batch.map(epgRowHTML).join(''));
  const token = state.token;
  ensureEpg(batch).then(() => { if (token === state.token) batch.forEach(fillEpgRow); });
  if (more) {
    if (tv.shown < tv.list.length) {
      more.innerHTML = '<button type="button" class="btn btn-ghost" data-tvmore>Afficher plus de chaînes (' + (tv.list.length - tv.shown) + ')</button>';
      if (tv.io) tv.io.disconnect();
      if ('IntersectionObserver' in window) {
        tv.io = new IntersectionObserver((en) => { if (en[0].isIntersecting) { tv.io.disconnect(); appendRows(); } }, { rootMargin: '200px' });
        tv.io.observe(more);
      }
    } else {
      more.innerHTML = '';
    }
  }
}

export function renderEpgGrid() {
  const epg = detailEl.querySelector('#epg');
  if (!epg) return;
  tv.list = tvFilter();
  tv.shown = 0;
  if (tv.io) tv.io.disconnect();
  if (!tv.list.length) {
    epg.innerHTML = '<p class="row-msg">' + (tv.cat === 'Favoris' ? 'Aucun favori pour le moment : clique sur l’étoile d’une chaîne.' : tv.cat === 'Ma playlist' ? 'Aucune chaîne : ajoute une playlist avec le bouton « Ma playlist ».' : 'Aucune chaîne dans cette catégorie.') + '</p>';
    return;
  }
  epg.innerHTML = epgShell();
  appendRows();
}

export function refreshCats() {
  const nav = detailEl.querySelector('#tv-cats');
  if (nav) nav.innerHTML = catsHTML();
}

export async function showTvLive() {
  teardownFiche();
  const token = state.token;
  state.kind = 'tvlive';
  document.title = 'TV en direct · Laststream';
  detailEl.innerHTML = topBar(false) + '<article class="svc-page is-loading" aria-busy="true" tabindex="-1"><header class="svc-head"><span class="sk sk-title"></span></header></article>';
  try { await loadTvChannels(); } catch (_) {
    if (token === state.token) detailEl.innerHTML = svcError('La TV en direct n’a pas pu être chargée.');
    return;
  }
  if (token !== state.token) return;
  detailEl.innerHTML = tvPageHTML();
  const h1 = detailEl.querySelector('#tv-title');
  if (h1) h1.focus({ preventScroll: true });
  renderEpgGrid();
}

export function showProg(chId, start) {
  const c = allChannels().find((x) => x.id === chId);
  if (!c) return;
  const p = (tv.epg.get(epgKey(c)) || []).find((x) => x.start === Number(start));
  const box = detailEl.querySelector('#tv-detail');
  if (!p || !box) return;
  detailEl.querySelectorAll('.epg-cell.is-sel').forEach((el) => el.classList.remove('is-sel'));
  const cell = detailEl.querySelector('[data-tvprog="' + chId.replace(/"/g, '\\"') + '|' + start + '"]');
  if (cell) cell.classList.add('is-sel');
  const now = Math.floor(Date.now() / 1000);
  box.innerHTML = (p.icon ? '<img class="tvd-img" src="' + esc(p.icon) + '" alt="" loading="lazy">' : '') +
    '<div class="tvd-t"><p class="tvd-ch">' + esc(c.name) + '</p><h2 class="tvd-title">' + esc(p.title) + '</h2>' +
    '<p class="tvd-time">' + fmtHM(p.start) + ' – ' + fmtHM(p.stop) + ' · ' + Math.round((p.stop - p.start) / 60) + ' min' + (p.start <= now && now < p.stop ? ' · <strong>En cours</strong>' : '') + (p.category ? ' · ' + esc(p.category) : '') + '</p>' +
    (p.desc ? '<p class="tvd-desc">' + esc(p.desc) + '</p>' : '') +
    '<button type="button" class="btn btn-primary" data-tvplay="' + esc(c.id) + '" data-tvctx="page">' + ICON.play + '<span>Regarder</span></button></div>';
}

export async function tvTest(save) {
  const form = detailEl.querySelector('#tv-form');
  const msg = detailEl.querySelector('#tv-form-msg');
  if (!form || !msg) return;
  const f = form.elements;
  const type = f.ttype.value;
  const cfg = type === 'xtream'
    ? { type, server: f.server.value.trim(), username: f.username.value.trim(), password: f.password.value }
    : { type, url: f.url.value.trim() };
  msg.textContent = 'Test en cours…';
  try {
    const j = await tvImport(cfg);
    msg.textContent = j.count + ' chaîne' + (j.count > 1 ? 's' : '') + ' trouvée' + (j.count > 1 ? 's' : '') + '.';
    if (save) {
      store('ls_tv_playlist', cfg);
      tv.user = j.channels || [];
      refreshCats();
      renderEpgGrid();
    }
  } catch (_) {
    msg.textContent = 'Playlist inaccessible ou refusée. Vérifie l’adresse et tes identifiants.';
  }
}
