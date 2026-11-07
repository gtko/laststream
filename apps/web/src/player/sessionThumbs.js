/* Miniatures au survol de la barre de lecture : vidéo d'aperçu, images ffmpeg de lastAddon, lecture par plages chez l'hébergeur. */
import { postLt, ltHealth } from '../data/lt';
import { ltUrl } from '../data/config';
import { analyzeUrl } from './skip';
import { serverBase } from './server';
import { thumbsAllowed, thumbSource } from './thumbs';
import { ThumbFeed, serverHasThumbs } from './thumbfeed';
import { createRangeFetch, parseDebridUrl } from '../sources/debrid/http';
import { makeLocalFeed, webCodecsAvailable, IdbThumbStore, stableSourceId } from '../thumbs';
import { knownBandwidthKbps } from '../sources/load';
import { S, storeGet, THUMBS_KEY } from './sessionState.js';

let addonThumbs = false;
let rangeLocal = null;
let rangeStore = null;

// ---------- Création de l'interface (une seule fois) ----------
export function thumbSourceOf(p) {
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

/** Le lecteur tamponne-t-il (attente de données) ? Les miniatures attendent alors, pour ne pas concurrencer la lecture. */
function playerBuffering() {
  try { return !!S.P && !!S.P.engine && S.P.engine.state().buffering === true; } catch (_) { return false; }
}

export function thumbsAllowedNow() {
  return !!S.P && !!S.P.view && !!S.P.engine && thumbsAllowed({
    enabled: storeGet(THUMBS_KEY) !== '0', hasSource: thumbSourceOf(S.P).mode !== 'none', duration: S.P.engine.state().duration,
    bandwidthKbps: knownBandwidthKbps(), torrentBuffering: playerBuffering(),
  });
}

/** Survol de la barre avec mpv : image ffmpeg de la tranche de 30 s la plus proche, affichée dès qu'elle est prête, sinon rien. */
export function addonThumb(t) {
  const img = S.ui.thumbImg;
  if (!thumbsAllowedNow()) { img.hidden = true; return; }
  if (!S.feed) {
    S.feed = new ThumbFeed({
      register: async () => {
        const url = thumbMediaUrl(S.P);
        if (!url || !S.P) return null;
        const st = S.P.engine.state();
        const r = await postLt('thumbs', { url, duration: Math.round(st.duration), start: Math.round(st.time) });
        return r && typeof r.key === 'string' ? r.key : null;
      },
      imageUrl: (key, index) => ltUrl('thumbs/' + key + '/' + index + '.webp'),
      fetchFn: (url, init) => fetch(url, init),
      makeUrl: (blob) => URL.createObjectURL(blob),
      revokeUrl: (url) => { try { URL.revokeObjectURL(url); } catch (_) { /* ignoré */ } },
      wait: (ms, signal) => new Promise((resolve) => { const id = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(id); resolve(); }, { once: true }); }),
      onReady: (index, url) => { if (S.feed && S.feed.targetIndex === index) { img.src = url; img.hidden = false; } },
    });
  }
  const url = S.feed.request(t, S.P.engine.state().duration);
  if (url) { img.src = url; img.hidden = false; } else img.hidden = true;
}

/** Survol de la barre, voie par plages : image clé lue directement chez l'hébergeur débridé (même IP que la lecture) puis décodée ici (WebCodecs). */
export function rangeThumb(t) {
  const img = S.ui.thumbImg;
  if (!thumbsAllowedNow()) { img.hidden = true; return; }
  if (!S.rangeFeed) {
    rangeStore = new IdbThumbStore();
    S.rangeFeed = new ThumbFeed({
      register: async (signal) => {
        // Clé de cache : infoHash + fichier de la source, jamais le lien débridé (il change à chaque régénération).
        const stream = S.P && S.P.view ? S.P.view.stream : null;
        const url = rangeUrlOf(S.P);
        const sourceId = url ? stableSourceId({ infoHash: stream && stream.infoHash, fileIdx: stream && stream.fileIdx, url }) : null;
        if (!sourceId) return null;
        rangeLocal = makeLocalFeed({
          sourceId, store: rangeStore, fetchFn: rangeHttp, isBuffering: playerBuffering,
          // Lien relu à chaque ouverture de la source : la version courante, sans être gardée ailleurs.
          resolve: async () => { const current = rangeUrlOf(S.P); return current ? { url: current } : null; },
        });
        return rangeLocal.register(signal);
      },
      imageUrl: (key, index) => rangeLocal.imageUrl(key, index),
      fetchFn: (url, init) => rangeLocal.fetchFn(url, init),
      maxParallel: 2,
      makeUrl: (blob) => URL.createObjectURL(blob),
      revokeUrl: (url) => { try { URL.revokeObjectURL(url); } catch (_) { /* ignoré */ } },
      wait: (ms, signal) => new Promise((resolve) => { const id = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(id); resolve(); }, { once: true }); }),
      onReady: (index, url) => { if (S.rangeFeed && S.rangeFeed.targetIndex === index) { img.src = url; img.hidden = false; } },
    });
  }
  const url = S.rangeFeed.request(t, S.P.engine.state().duration);
  if (url) { img.src = url; img.hidden = false; } else img.hidden = true;
}

export function cancelAddonThumb() {
  if (S.rangeFeed) S.rangeFeed.cancel();
  if (S.feed) S.feed.cancel();
  if (S.ui && S.ui.thumbImg) S.ui.thumbImg.hidden = true;
}

/** La capacité « miniatures » est annoncée par /lt/health (ffmpeg présent côté lastAddon) ; l'option est masquée sinon. */
export function refreshAddonThumbs() {
  if (addonThumbs) return;
  ltHealth().then((h) => { addonThumbs = serverHasThumbs(h); if (S.ui) S.ui.refreshPanel(); }).catch(() => undefined);
}
