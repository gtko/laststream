/* « Lecture » : tiroir Sources (streams lastAddon triés par score, groupés par qualité) et lecteur plein écran basique. */
import { isConfigured } from '../data/config';
import {
  copiesOf, fetchStreams, formatBitrate, formatSize, groupByQuality, imdbIdOf, languageLabel,
  matchesLanguage, QUALITY_LABEL, sortStreams,
} from '../data/sources';
import { getLaststream } from '../data/stream';
import { userStore } from '../data/userStore';
import { modalBody } from './dom.js';
import { esc } from './util.js';
import { nextToWatch } from './fiche.js';
import { hv } from './hover.js';
import { closeModal, openModal } from './modal.js';
import { state } from './state.js';

let req = null; // demande en cours : { type, id, name, season, episode, key }
let streams = [];
let drawerToken = 0;

const vp = () => document.getElementById('vplayer');
const vVideo = () => document.getElementById('vplayer-video');

/** Cible de lecture d'après le bouton « Lecture » cliqué (fiche, épisode, aperçu au survol). */
export function playFrom(btn) {
  const hc = btn.closest('#hovercard');
  let type; let id; let name; let season = null; let episode = null;
  const ep = btn.closest('.ep');
  if (hc) {
    const it = state.byKey.get(hv.key);
    if (!it) return;
    ({ type, id, name } = it);
    if (type === 'tv') { season = 1; episode = 1; }
  } else {
    const m = state.model;
    if (!m) return;
    ({ type, name } = m);
    id = m.id;
    if (type === 'tv') {
      if (ep) {
        [season, episode] = ep.dataset.ep.split(':').map(Number);
      } else {
        const n = nextToWatch(m);
        season = n ? n.s : 1;
        episode = n ? n.e : 1;
      }
    }
  }
  openSources({ type, id: String(id), name, season, episode, key: type + ':' + id }, btn);
}

const badge = (txt, cls) => '<span class="badge' + (cls ? ' ' + cls : '') + '">' + esc(txt) + '</span>';

function sourceItem(s, i, all) {
  const info = getLaststream(s);
  const hasUrl = typeof s.url === 'string' && /^https?:\/\//i.test(s.url);
  const title = info
    ? [info.source !== 'unknown' ? info.source : '', info.codec !== 'unknown' ? info.codec : '', info.hdr.join(' ')].filter(Boolean).join(' · ') || info.resolution
    : String(s.name || 'Source').replace(/\n/g, ' · ');
  const badges = [];
  if (info) {
    const ok = matchesLanguage(info, 'fr');
    badges.push(badge((ok ? '✓ ' : '') + languageLabel(info), ok ? 'b-ok' : ''));
    if (info.sizeBytes) badges.push(badge(formatSize(info.sizeBytes)));
    const br = formatBitrate(info.estBitrateKbps);
    if (br) badges.push(badge(br));
    if (info.cached) badges.push(badge('Cache', 'b-cache'));
    const copies = copiesOf(s, all);
    if (copies > 1) badges.push(badge('×' + copies + ' copies'));
    if (!info.cached && info.seeders != null) badges.push(badge(info.seeders + ' seeders'));
  }
  if (s.behaviorHints && s.behaviorHints.notWebReady) badges.push(badge('Lecture navigateur incertaine', 'b-warn'));
  const file = (s.behaviorHints && s.behaviorHints.filename) || '';
  return '<li><button type="button" class="src" data-src="' + i + '"' + (hasUrl ? '' : ' disabled') + '>' +
    '<span class="src-title">' + esc(title) + '</span>' +
    '<span class="src-badges">' + badges.join('') + '</span>' +
    (file ? '<span class="src-file">' + esc(file) + '</span>' : '') +
    (hasUrl ? '' : '<span class="src-file">Torrent sans lien direct : non lisible dans le navigateur.</span>') + '</button></li>';
}

function drawerHTML(inner) {
  const label = req ? (req.name || '') + (req.season != null ? ' · S' + req.season + ' É' + req.episode : '') : '';
  return '<div class="drawer"><h2 id="modal-title" class="drawer-title">Sources</h2>' +
    (label ? '<p class="drawer-text"><strong>' + esc(label) + '</strong></p>' : '') + inner + '</div>';
}

export async function openSources(request, opener) {
  req = request;
  streams = [];
  const token = ++drawerToken;
  openModal(drawerHTML('<ul class="drawer-list" aria-hidden="true"><li class="sk sk-src"></li><li class="sk sk-src"></li><li class="sk sk-src"></li></ul>'), opener, 'is-drawer');
  const show = (inner) => { if (token === drawerToken) { modalBody.innerHTML = drawerHTML(inner); } };
  if (!isConfigured()) { show('<p class="drawer-text">lastAddon n’est pas configuré. Renseigne-le dans les réglages.</p>'); return; }
  try {
    const imdb = await imdbIdOf(request.type, request.id);
    if (!imdb) { show('<p class="drawer-text">Aucun identifiant IMDb pour ce titre : impossible de chercher des sources.</p>'); return; }
    request.imdb = imdb;
    streams = sortStreams(await fetchStreams(request.type, imdb, request.season, request.episode));
    if (!streams.length) { show('<p class="drawer-text">Aucune source trouvée pour le moment.</p>'); return; }
    const groups = groupByQuality(streams);
    show(groups.map((g) => '<h3 class="src-group">' + esc(QUALITY_LABEL[g.key]) + ' <span>' + g.streams.length + '</span></h3><ul class="src-list">' +
      g.streams.map((s) => sourceItem(s, streams.indexOf(s), streams)).join('') + '</ul>').join(''));
  } catch (_) {
    show('<p class="drawer-text">Les sources n’ont pas pu être chargées. Vérifie que lastAddon répond, puis réessaie.</p>');
  }
}

// ---------- Lecteur plein écran basique ----------
let lastSave = 0;
let opener = null;

function saveProgress(force) {
  const v = vVideo();
  if (!req || !v || !v.duration || !isFinite(v.duration)) return;
  const now = Date.now();
  if (!force && now - lastSave < 10000) return;
  lastSave = now;
  const it = state.byKey.get(req.key) || {};
  userStore.setProgress({
    key: req.key, type: req.type, id: Number(req.id), title: req.name || it.name || '', poster: it.posterPath || '',
    backdrop: it.backdropPath || '', season: req.season != null ? req.season : undefined, episode: req.episode != null ? req.episode : undefined,
    position: v.currentTime, duration: v.duration,
  });
}

function openVideo(url, from) {
  const box = vp();
  const v = vVideo();
  if (!box || !v) return;
  opener = from || document.activeElement;
  closeModal(true);
  const saved = req ? userStore.getProgress(req.key, req.season != null ? req.season : undefined, req.episode != null ? req.episode : undefined) : null;
  v.onloadedmetadata = () => {
    if (saved && saved.duration && saved.position / saved.duration > 0.02 && saved.position / saved.duration < 0.95) v.currentTime = saved.position;
  };
  v.ontimeupdate = () => saveProgress(false);
  v.onpause = () => saveProgress(true);
  v.onerror = () => {
    const err = document.getElementById('vplayer-error');
    if (err) err.hidden = false;
  };
  const err = document.getElementById('vplayer-error');
  if (err) err.hidden = true;
  document.getElementById('vplayer-title').textContent = req ? (req.name || '') + (req.season != null ? ' · S' + req.season + ' É' + req.episode : '') : '';
  box.hidden = false;
  document.body.classList.add('modal-open');
  v.src = url;
  v.play().catch(() => {});
  const c = box.querySelector('[data-vclose]');
  if (c) c.focus({ preventScroll: true });
}

export function closeVideo() {
  const box = vp();
  const v = vVideo();
  if (!box || box.hidden) return;
  saveProgress(true);
  if (v) { v.pause(); v.removeAttribute('src'); v.onerror = null; try { v.load(); } catch (_) { /* ignoré */ } }
  box.hidden = true;
  document.body.classList.remove('modal-open');
  const t = opener;
  opener = null;
  if (t && t.isConnected && t.focus) t.focus({ preventScroll: true });
}

modalBody.addEventListener('click', (e) => {
  const b = e.target instanceof Element && e.target.closest('[data-src]');
  if (!b) return;
  e.preventDefault();
  const s = streams[Number(b.dataset.src)];
  if (s && typeof s.url === 'string') openVideo(s.url, b);
});

document.addEventListener('click', (e) => {
  if (e.target instanceof Element && e.target.closest('[data-vclose]')) { e.preventDefault(); closeVideo(); }
});

// Phase de capture : le lecteur prime sur la navigation (Échap / Retour arrière ne quittent pas la fiche).
document.addEventListener('keydown', (e) => {
  const box = vp();
  if (!box || box.hidden) return;
  if (e.key === 'Escape' || e.key === 'Backspace') {
    e.preventDefault();
    e.stopImmediatePropagation();
    closeVideo();
  }
}, true);
