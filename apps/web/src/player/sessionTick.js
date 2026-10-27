/* Boucle périodique de la lecture : interface, sous-titres, blocage, saut, carte suivante, progression. */
import { isConfigured } from '../data/config';
import { postLt, skipSegments } from '../data/lt';
import { clipStep } from '../data/watchWith';
import { getSkipPref } from '../data/prefs';
import { userStore } from '../data/userStore';
import { addonProgressKey } from './addonRequest';
import { saveAddonProgress } from '../data/addonUserStore';
import { IMG } from '../ui/constants.js';
import { showRatePrompt } from '../ui/rate.js';
import { state as appState } from '../ui/state.js';
import { onWatched, watchedPlan } from '../downloads/afterWatch';
import { autoNextEpisode, nextCardLabels } from './episodes';
import { attemptsAfterStable } from './failover';
import { isOfflineView } from './offlinePlay';
import { isWatched, shouldSave } from './progress';
import { activeSkip, analyzeUrl, autoSkipEnabled, chapterMarks, movieEndRow, nextEpisodeCard, normalizeSkip, shouldRepoll, validAnalyzeDuration } from './skip';
import { serverBase } from './server';
import { nextPhase, shouldBeReady } from './phase';
import { MEMORY_EVERY_TICKS, MemoryWatch, memorySnapshot } from './memoryProbe';
import { createCueView } from './cueView';
import { createTickLoop, tickPlan } from './tickLoop';
import { partyBridge } from '../party/bridge';
import { presenceTick } from './presenceV2';
import { playEpisode, submitTarget } from './sessionActions.js';
import { closePlayer } from './sessionClose.js';
import { failover } from './sessionFailover.js';
import { continuesPart, ensureEpisodes } from './sessionOpen.js';
import { friendChipTick, notesTick, partyAdapter, refreshNoteMarkers, socialTick } from './sessionSocial.js';
import { S, AUTOSYNC_TARGET, miniState, nextRef } from './sessionState.js';
import { finishAutoSync } from './sessionTracks.js';


export function onEnded() {
  const p = S.P;
  if (!p || p.finished) return;
  saveProgress(true);
  markWatched();
  if (partyBridge.guestLocked()) return; // en salon, c'est l'hôte qui passe à l'épisode suivant
  const nx = autoNextEpisode(nextRef(), p.episodes, getSkipPref('filler')); // jamais vers un épisode pas encore diffusé : lancement manuel
  // Fin d'une partie d'émission : la suite enchaîne même sans le réglage « épisode suivant », sauf si la carte a été refusée.
  const part = nx && !miniState.mini && continuesPart(p, nx) && !p.nextDismissed;
  if (nx && (getSkipPref('nextEpisode') || part)) { playEpisode(nx.season, nx.episode); return; }
  p.finished = true;
  const key = p.req.key;
  closePlayer();
  // Titre d'addon : pas de demande de note (sa clé « addon:<type>:<id> » n'est pas un id TMDB, rate.js ne sait pas la lire).
  if (!p.addon) setTimeout(() => showRatePrompt(key), 600);
}

// ---------- Boucle périodique ----------

/**
 * Fin d'un extrait partagé : met la lecture en pause une seule fois à `p.stopAt`. L'extrait n'est « armé » qu'une fois la
 * lecture arrivée au début ; un retour en arrière avant le début, ou un salon (watch party), l'annule. Un autre titre ouvre
 * une autre session, donc sans arrêt.
 */
function clipTick(p, st) {
  if (p.stopAt === undefined) return;
  if (partyBridge.isActive()) { p.stopAt = undefined; return; }
  const step = clipStep({ from: p.stopFrom, stopAt: p.stopAt, armed: p.clipArmed }, st.time);
  p.clipArmed = step.armed;
  if (step.action === 'cancel') { p.stopAt = undefined; return; }
  if (step.action === 'wait') return;
  p.stopAt = undefined;
  try { p.engine.pause(); } catch (_) { /* ignoré */ }
  S.ui.toast('Fin de l’extrait', 3000);
}
export const memoryWatch = new MemoryWatch();
/** memoryProbe compte des relevés de 100 ms ; la boucle lente en fait un par seconde. */
const MEMORY_EVERY_SLOW_TICKS = Math.round(MEMORY_EVERY_TICKS / 10);
const cueView = createCueView();
let fastN = 0;
let slowN = 0;

/** Journal de debug (console.debug, repris par Sentry en fil d'Ariane) : tas JS et collections du lecteur, toutes les 5 min de lecture. */
function logMemory(p) {
  const s = p.subs;
  const snap = memorySnapshot({
    thumbFrames: S.thumbs ? S.thumbs.cache.size : 0, thumbVideo: S.thumbs && S.thumbs.video ? 1 : 0,
    feedImages: (S.feed ? S.feed.cached : 0) + (S.rangeFeed ? S.rangeFeed.cached : 0), notes: p.notes ? p.notes.list.length : 0, cues: s.cues.length + s.cues2.length,
  });
  const growth = memoryWatch.growthMb(snap);
  if (memoryWatch.suspicious(snap)) console.warn('[player] mémoire : le tas a grossi de ' + growth + ' Mo depuis le début de la lecture', snap);
  else console.debug('[player] mémoire', snap, growth === null ? '' : '(+' + growth + ' Mo)');
}

/** Contexte de la cadence : session ouverte, onglet caché, lecture en pause, premier affichage passé, moteur, salon. */
function tickContext() {
  const p = S.P;
  let paused = false;
  if (p && p.engine && p.view) { try { paused = !!p.engine.state().paused; } catch (_) { paused = false; } }
  return {
    open: !!p, hidden: document.hidden, paused, settled: !!p && p.phase !== 'loading', kind: p && p.engine ? p.engine.kind : '', party: partyBridge.isActive(),
  };
}

/** Sous-titre seul : rafraîchi tout de suite quand la boucle d'interface dort (saut en pause, piste choisie, style changé). */
function refreshCue() {
  const p = S.P;
  if (!p || !p.engine || !p.view) return;
  cueView.render(p.subs, p.engine.kind, p.engine.state().time, (html, style, html2) => S.ui.setCue(html, style, html2));
}

const loop = createTickLoop({
  plan: () => tickPlan(tickContext()),
  fast: fastTick,
  slow: slowTick,
  nudge: refreshCue,
  // Après un sommeil, la position n'a pas bougé « depuis longtemps » : sans cela, la reprise passerait pour un blocage.
  wake: () => { if (S.P && S.P.watch) S.P.watch.reset(Date.now()); },
});

/** Aligne les boucles sur l'état de la lecture : à appeler à l'ouverture, au play / pause, au retour de l'onglet, au changement de moteur. */
export const syncTicks = () => loop.sync();
/** Arrête les boucles (fermeture de la session ou ouverture de la suivante). */
export function stopTicks() {
  loop.stop();
  fastN = 0;
  slowN = 0;
  cueView.forget();
}
/** Affichage à jour sans attendre la boucle d'interface (arrêtée en pause) : sous-titre après un saut, un choix de piste ou de style. */
export const nudgeTick = () => loop.nudge();
/** Les boucles dorment, mais la lecture continue (onglet caché) : pas de relevé de progression sans elles. */
export const ticksAsleep = () => !!S.P && !loop.running().slow;

/** Relevé de l'interface (250 ms) : extrait partagé, notes, sous-titres, barre de lecture. */
function fastTick() {
  const p = S.P;
  if (!p || !p.engine || !p.view) return;
  const st = p.engine.state();
  fastN += 1;
  clipTick(p, st);
  notesTick(p, st);
  socialTick(p, st);
  partyBridge.tick(partyAdapter(p)); // 250 ms ; le contrôleur limite lui-même suivi et sauts à 500 ms
  const s = p.subs;
  if (s.native && p.engine.kind === 'html' && fastN % 2 === 0) s.nativeCues = p.engine.nativeCues(); // 500 ms
  cueView.render(s, p.engine.kind, st.time, (html, style, html2) => S.ui.setCue(html, style, html2));
  refreshUI(st);
}

/** Relevé lent (1 s) : présence, salon, puce « ami », blocage, saut, carte suivante, progression. */
function slowTick() {
  const p = S.P;
  if (!p || !p.engine || !p.view) return;
  const st = p.engine.state();
  slowN += 1;
  if (slowN % MEMORY_EVERY_SLOW_TICKS === 0) logMemory(p);
  friendChipTick(p, st);
  presenceTick(st);
  if (!loop.running().fast) partyBridge.tick(partyAdapter(p)); // boucle d'interface arrêtée (pause, salon) : c'est la lente qui suit le salon
  const s = p.subs;
  if (p.choice && !p.failing && !p.resumeTimer) {
    const now = Date.now();
    const verdict = p.watch.tick(now, st.time, st.paused || st.ended || st.seeking, st.cacheTime ?? null);
    // Lecture stable depuis 2 min : les essais repartent, sinon des micro-coupures espacées épuisent MAX_ATTEMPTS (LAST-186).
    const forgiven = attemptsAfterStable(p.attempts, p.view.index, p.watch.stableFor(now));
    if (forgiven) Object.assign(p, forgiven);
    if (verdict === 'stalled') failover('La lecture est bloquée');
    else if (verdict === 'startup-timeout') failover('La source met trop de temps à démarrer');
  }
  if (s.sync.state === 'collecting') {
    const secs = s.sync.probe.seconds();
    if (secs >= AUTOSYNC_TARGET) finishAutoSync(); else S.ui.refreshPanel();
  }
  if (st.duration > 0) {
    const seg = activeSkip(p.segments, st.time);
    if (seg && autoSkipEnabled(seg.kind, getSkipPref, seg.inferred) && p.skipped !== seg.start && p.undone !== seg.start) {
      p.skipped = seg.start;
      p.engine.seek(seg.end);
      p.watch.reset(Date.now());
      S.ui.toast((seg.kind === 'intro' ? 'Intro passée' : 'Récap passé'), 3000, { label: 'Annuler', run: () => { p.undone = seg.start; p.engine.seek(seg.start); } });
    }
    // Mini-lecteur : ni pastille de saut ni carte (le saut automatique, s'il est activé, reste actif plus haut).
    const mini = miniState.mini;
    S.ui.setSkip(!mini && seg && p.skipped !== seg.start ? seg : null);
    const nx = autoNextEpisode(nextRef(), p.episodes, getSkipPref('filler')); // épisode non diffusé : ni carte ni enchaînement automatique
    const part = !!nx && continuesPart(p, nx);
    const card = nextEpisodeCard(p.segments, st.time, st.duration, !!nx, getSkipPref('nextEpisode') || (part && !mini));
    if (card.show && !p.nextDismissed && nx) {
      const ep = p.episodes.get(nx.season);
      const info = ep && ep.find((e) => e.episode === nx.episode);
      const name = info && (info.part ? info.part.title : info.name);
      const bg = p.meta.backdrop ? IMG('w780', p.meta.backdrop) : p.meta.poster ? IMG('w342', p.meta.poster) : '';
      if (!mini) {
        S.ui.setNextCard({
          title: 'S' + nx.season + ':É' + nx.episode + (name ? ' « ' + name + ' »' : ''), still: (info && info.still) || bg, countdown: card.countdown, ratio: card.ratio,
          // Suite directe d'une émission : on le dit, pour que la fin de la partie 1 ne passe pas pour un épisode coupé.
          ...nextCardLabels(part, info),
        });
      }
      if (!ep && !p.episodesLoading && !p.episodesError) ensureEpisodes(nx.season); // une demande à la fois : pas une par seconde
      if (card.countdown === 0 && !p.autoNexting && !partyBridge.guestLocked()) { p.autoNexting = true; playEpisode(nx.season, nx.episode); }
    } else S.ui.setNextCard(null);
    S.ui.setEndRow(!mini && p.req.type === 'movie' && !p.endDismissed && movieEndRow(p.segments, st.time, st.duration));
    if (!st.paused) saveProgress(false, st);
    maybeAnalyze(st);
    maybeRepoll(st);
    if (!p.watchedMarked && isWatched(st.time, st.duration)) markWatched();
  }
}

/** Une fois par épisode, lastAddon reçoit le lien lu pour analyser l'épisode (intro, générique). Les erreurs sont ignorées. */
function maybeAnalyze(st) {
  const p = S.P;
  if (p.analyzed || p.addon || isOfflineView(p.view) || !p.imdb || !isConfigured() || st.time < 3 || !validAnalyzeDuration(st.duration)) return;
  const played = typeof p.view.stream.url === 'string' && /^https?:/i.test(p.view.stream.url) ? p.view.stream.url : p.mediaUrl;
  const url = analyzeUrl(played, serverBase()) || analyzeUrl(p.mediaUrl, serverBase());
  p.analyzed = true;
  if (!url) return;
  const tgt = submitTarget();
  postLt('skip/analyze', { ...tgt, mediaUrl: url, duration: Math.round(st.duration) }).catch(() => undefined);
}

/** Pendant que lastAddon analyse, on redemande les segments (30 s, 10 fois au plus) et les boutons se mettent à jour. */
function maybeRepoll(st) {
  const p = S.P;
  const sp = p.skipPoll;
  if (!shouldRepoll({ analyzing: sp.analyzing, polls: sp.polls, lastAt: sp.lastAt, now: Date.now(), playing: !st.paused })) return;
  sp.polls += 1;
  sp.lastAt = Date.now();
  const t = submitTarget();
  skipSegments(t.type, t.imdbId, t.season, t.episode).then((r) => {
    if (S.P !== p) return;
    p.segments = normalizeSkip(r);
    sp.analyzing = !!r && r.analyzing === true;
  }).catch(() => undefined);
}

export function refreshUI(st) {
  if (!S.P || !S.P.engine || !S.P.view) return;
  const s = st || S.P.engine.state();
  // Première image prête : le chargeur s'efface en fondu, puis les contrôles apparaissent (et se masquent seuls après 3 s).
  if (S.P.phase === 'loading' && !S.P.resumeTimer && !S.ui.panel && !S.P.failing && shouldBeReady(s)) {
    S.P.phase = nextPhase(S.P.phase, 'media');
    S.ui.setLoading(null);
    S.ui.setPhase(S.P.phase);
    syncTicks(); // démarrage passé : une lecture en pause n'a plus besoin des boucles
  }
  S.ui.update(S.shell ? { ...s, fullscreen: S.shellFullscreen } : s, chapterMarks(S.P.segments, s.duration));
  if (S.P.notes) refreshNoteMarkers(S.P.notes, s.duration);
}

// ---------- Progression ----------

export function saveProgress(force, st) {
  const p = S.P;
  if (!p || !p.engine || !p.view) return;
  // Diffusion Chromecast : la position est celle du téléviseur, la lecture locale est en pause (sessionCast).
  const s = st || (p.casting && p.casting.progress.last()) || p.engine.state();
  if (!shouldSave(Date.now(), p.lastSave, force, s.duration) || s.time <= 1) return;
  p.lastSave = Date.now();
  if (p.addon) {
    // Titre d'addon : stockage séparé, jamais dans PROGRESS_KEY (clé numérique TMDB, découpée sur « : » par ui/continue.js).
    const episode = p.cur.season != null && p.cur.episode != null ? { season: p.cur.season, episode: p.cur.episode } : undefined;
    saveAddonProgress(addonProgressKey(p.addon), { t: s.time, d: s.duration, at: Date.now(), ...(episode ? { episode } : {}) });
    return;
  }
  const it = appState.byKey.get(p.req.key) || {};
  userStore.setProgress({
    key: p.req.key, type: p.req.type, id: Number(p.req.id), title: p.meta.title || it.name || '', poster: p.meta.poster || it.posterPath || '',
    backdrop: p.meta.backdrop || it.backdropPath || '', season: p.cur.season != null ? p.cur.season : undefined, episode: p.cur.episode != null ? p.cur.episode : undefined,
    position: s.time, duration: s.duration,
  });
}

export function markWatched() {
  const p = S.P;
  if (!p || p.watchedMarked) return;
  p.watchedMarked = true;
  if (p.addon) return; // le « vu » du serveur est indexé par id TMDB ; la progression de l'addon suffit
  const refs = p.req.type === 'tv' && p.cur.season != null ? [{ season: p.cur.season, episode: p.cur.episode }] : null;
  Promise.resolve(userStore.setWatched(p.req.key, refs, true)).catch(() => {});
  // Fichier téléchargé : le supprimer pendant qu'on le lit casserait la lecture, on attend la fermeture (teardown).
  const plan = watchedPlan(isOfflineView(p.view), p.req.key, refs?.[0].season, refs?.[0].episode);
  if (plan.later) p.deleteAfterWatch = plan.later;
  else void onWatched(p.req.key, refs?.[0].season, refs?.[0].episode).catch(() => {});
}
