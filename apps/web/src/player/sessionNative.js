/* Lecteur natif Android : choix de piste ou de source faits dans son panneau, listes et options poussées vers lui. */
import { wantedSubLang } from '../data/langPrefs';
import { userStore } from '../data/userStore';
import { POLL_EVERY_MS, pollSources } from '../sources/load';
import { originSummary } from '../sources/info';
import { getMemory, remember } from './memory';
import { toNativeEpisodes, toNativeSegments, toNativeSources } from './native';
import { getBufferLevel, vlcNetworkCachingMs } from './bufferLevel';
import { playView } from './sessionPlay.js';
import { S, activeLangPrefs, audioPreference, headingFor, nextRef, sourceLine } from './sessionState.js';
import { effectiveSubMode } from './sessionTracks.js';


/** Choix de piste fait dans le panneau du lecteur natif : mémorisé par titre, comme dans le lecteur web. */
export function onNativeTrack(d) {
  if (!S.P || !d) return;
  // Les pistes que nous venons d'appliquer (ou celles que le lecteur choisit seul au départ) ne sont pas un choix de l'utilisateur.
  if (!S.P.applier.done || Date.now() - S.P.autoAppliedAt < 2500) return;
  S.P.applier.markManual();
  if (d.kind === 'audio' && d.lang) remember(S.P.req.key, { audio: d.lang });
  if (d.kind === 'sub') remember(S.P.req.key, { sub: d.lang && d.lang !== 'off' ? d.lang : 'off' });
}

/** Source choisie dans le panneau natif : même bascule que le sélecteur web, à la position courante. */
export function onNativeSource(d) {
  const p = S.P;
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
  const p = S.P;
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
export async function pollMoreSources(p) {
  const token = p.token;
  const seq = (p.pollSeq = (p.pollSeq || 0) + 1); // une seule boucle à la fois (la fusion de la liste mémorisée en relance une)
  let cur = p.loaded;
  for (let i = 0; cur && cur.pending && cur.pending.length && i < 8; i += 1) {
    await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
    if (!S.P || S.P.token !== token || p.pollSeq !== seq) return;
    const next = await pollSources(p.req, cur).catch(() => cur);
    if (!S.P || S.P.token !== token || p.pollSeq !== seq) return;
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
export function nativeOptions() {
  const p = S.P;
  const mem = getMemory(p.req.key);
  const nx = nextRef();
  const info = nx && (p.episodes.get(nx.season) || []).find((e) => e.episode === nx.episode);
  return {
    title: headingFor(p)[0],
    subtitle: headingFor(p)[1],
    // Durée du fichier (sonde) : le lecteur natif la garde en repli pour sauvegarder la progression.
    durationSec: p.probeTracks.durationSec || 0,
    // Mémoire tampon réseau de libVLC, selon le réglage « Mémoire tampon » de cet appareil.
    networkCachingMs: vlcNetworkCachingMs(getBufferLevel()),
    preferredAudioLang: audioPreference()[0] || '',
    preferredSubLang: mem.sub || wantedSubLang(activeLangPrefs()) || '',
    subMode: mem.sub ? 'always' : effectiveSubMode(),
    skipSegments: toNativeSegments(p.segments),
    ...nativeLists(),
    nextEpisode: nx ? { title: 'S' + nx.season + ':É' + nx.episode + (info && info.name ? ' « ' + info.name + ' »' : ''), still: (info && info.still) || '' } : null,
  };
}

/** Pousse au lecteur natif ce qui arrive après l'ouverture (segments, épisode suivant, titre). */
export function syncNative() {
  const p = S.P;
  if (!p || !p.engine || p.engine.kind !== 'native') return;
  const o = nativeOptions();
  p.engine.update({ skipSegments: o.skipSegments, nextEpisode: o.nextEpisode, title: o.title, subtitle: o.subtitle, sources: o.sources, episodes: o.episodes });
}
