/* Lancement d'une source : lien, préparation, course entre candidats, lecture locale, moteur et son décodé par l'app. */
import { getBase } from '../data/config';
import { streamingServerFor } from '../data/lan';
import { requestKey } from '../sources/load';
import { clientCopiesOf, isClientStream } from '../sources/info';
import { chooseEngine, directVideoOk, probeConversion } from './engine';
import { MpvEngine, NativeEngine } from './engines.js';
import { resetSubsLoad } from './subsLoad';
import { StallWatch } from './failover';
import { raceCandidates } from './race';
import { isOfflineView } from './offlinePlay';
import { rememberLaunch } from './launchCache';
import { markBad, sourceKey } from './memory';
import { NativePlayer, isNativePlayer } from './native';
import { connectShell } from './shell';
import { fetchProbe, hlsMasterUrl, hlsQuery, newSessionId, proxyUrl, SERVER_STORAGE_KEY as SERVER_KEY, serverAlive, serverBase, setShellServerAddress } from './server';
import { parseProbe } from './tracks';
import { nextPhase } from './phase';
import { debrid, PROVIDER_LABEL } from '../sources/debridClient';
import { partyBridge } from '../party/bridge';
import { fileCodecsOf } from '../party/compat';
import { probeUrl as probeHeaderUrl } from '../party/headerCodecs';
import { startWebAudio } from './webaudio/controller';
import { launchLang, listed, MEMORY_STEPS, searchInstead } from './session.js';
import { markAllowed, showSourcesPanel } from './sessionActions.js';
import { failover, localFailure, nextCandidate, recordRace } from './sessionFailover.js';
import { nativeOptions, pollMoreSources } from './sessionNative.js';
import { loaderExtra } from './sessionOpen.js';
import { partyAdapter, resolveRelayUrl } from './sessionSocial.js';
import { S, abortError, audioPreference, badKey, describeView, getCaps, hasEpisodesPanel, miniState, nextRef, sourceLine, storeGet } from './sessionState.js';
import { refreshAddonThumbs } from './sessionThumbs.js';
import { refreshUI, syncTicks } from './sessionTick.js';
import { stopAutoSync, toastBusy } from './sessionTracks.js';
import { bindEngine } from './sessionUi.js';
import { castSourceChanged } from './sessionCast.js';
import { NOTE_NOT_EXTERNAL, externalPlan, openExternal } from './externalScreen.js';
import { looksUnplayableOnIOS } from './external';


/** Message clair pour une erreur de débridage sur l'appareil. */
function clientError(e) {
  const code = e && e.code;
  if (code === 'no_provider') return 'Aucun débrideur configuré : ajoute une clé dans Réglages > Sources > Avancé.';
  if (code === 'all_unavailable') return 'Tous tes débrideurs sont indisponibles pour le moment (compte suspendu, quota ou clé invalide). Voir Réglages > Sources > Avancé.';
  if (code === 'host_not_allowed' || code === 'web_unsupported') return 'Ce débrideur ne peut pas être appelé depuis le navigateur : utilise l’application Windows ou Android.';
  if (code === 'not_ready') return 'Cette source n’est pas encore prête chez le débrideur (pas en cache).';
  return 'Débridage impossible' + (code ? ' (' + code + ')' : '') + '.';
}

/** `fresh` : redemande le lien au débrideur de l'appareil (mémo et lien partagé ignorés), pour la reconnexion pendant la lecture. */
export async function resolveMedia(view, signal, local = false, { fresh = false } = {}) {
  const s = view.stream;
  const up = await serverAlive();
  const base = serverBase();
  const hints = s.behaviorHints || {};
  if (typeof s.url === 'string' && /^https?:\/\//i.test(s.url)) {
    const ph = hints.proxyHeaders;
    if (up && ph && typeof ph === 'object') return { url: proxyUrl(base, s.url, ph.request || {}, ph.response || {}), up, base, proxied: true };
    return { url: s.url, up, base };
  }
  // Torrent livré sans lien par lastAddon : cache et déblocage sur l'appareil (AllDebrid, TorBox, Real-Debrid), jamais par le serveur.
  if (isClientStream(s)) {
    const { copies, season, episode } = clientCopiesOf(s);
    try {
      // `local` : le lien partagé a échoué, il est invalidé sur le serveur puis débloqué ici.
      const r = local ? await debrid().recoverShared(copies, { season, episode }, signal) : await debrid().resolve(copies, { season, episode }, signal, fresh ? { skipShared: true } : {});
      // Sans fournisseur, le lien vient d'un autre appareil du compte (partage serveur).
      if (S.P) S.P.debridVia = (r.provider && PROVIDER_LABEL[r.provider]) || 'Appareil du compte';
      return { url: r.url, up, base, provider: r.provider, shared: r.provider === undefined };
    } catch (e) {
      throw new Error(clientError(e));
    }
  }
  // Jamais de lecture torrent (P2P) : une source sans lien HTTP(S) n'est pas lisible, il faut un débrideur.
  throw new Error('Cette source n’a pas de lien lisible : un débrideur (AllDebrid) est nécessaire, la lecture torrent est désactivée.');
}

/**
 * Préparation d'une source, interruptible : lien (lastAddon /play débridé ou lien HTTP direct), sonde du fichier, choix du moteur et, pour le
 * transcodage, création de la session HLS (premier appel de la playlist, qui démarre le travail du serveur).
 * `direct` : même source mais en lecture directe, pour démarrer vite quand seule la piste audio demande le transcodage.
 */
async function prepareView(p, cand, signal, local = false, opts = {}) {
  const { view, direct } = cand;
  const shell = await connectShell();
  const native = !shell && isNativePlayer();
  // Android : le serveur de streaming Stremio tourne sur le même PC que lastAddon (port 11470), sauf réglage contraire.
  if (native && !storeGet(SERVER_KEY)) { const b = streamingServerFor(getBase()); if (b) setShellServerAddress(b); }
  if (signal.aborted) throw abortError();
  // Drapeau propre à cette tentative : une préparation qui échoue avant la résolution ne doit pas hériter d'un ancien partage.
  view.fromShare = false;
  const media = await resolveMedia(view, signal, local, opts);
  view.fromShare = media.shared === true;
  if (signal.aborted) throw abortError();
  // Lecteur externe : décidé ici, avant la sonde et le moteur, qui ne servent pas à une lecture externe (voir externalPlan).
  let ext = externalPlan(view, media);
  // Lien passant par le serveur : impossible hors de l'app. Ailleurs, la lecture reste intégrée, avec un avis. Sur iPhone et iPad, pareil
  // pour un format que le lecteur intégré lit ; un MKV (format illisible sur iOS) garde l'écran bloqué.
  if (ext && ext.blocked && (ext.platform !== 'ios' || !looksUnplayableOnIOS(media.url, view.filename || media.url))) { p.notice = NOTE_NOT_EXTERNAL; ext = null; }
  if (ext) return { shell, media, probe: null, choice: ext, conversion: 'none', hlsUrl: null, hlsId: '', direct: !!direct };
  let probe = p.hint && p.hint.url === media.url ? p.hint.probe : null;
  if (!shell && !native && media.up && !probe) probe = await fetchProbe(media.url, media.base, signal);
  if (signal.aborted) throw abortError();
  let choice = chooseEngine({
    shell: !!shell, native, serverUp: media.up, probe, caps: getCaps(), notWebReady: view.notWebReady,
    name: view.filename || media.url, forceTranscoding: p.forceHls && !direct,
    preferredLang: audioPreference()[0], audioTracksSupported: !!S.ui.video.audioTracks,
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

/**
 * Préparation d'un candidat, avec repli sur le déblocage local : un lien partagé qui échoue à la préparation (session refusée,
 * lien mort) est invalidé sur le serveur, débloqué sur cet appareil et republié ; la préparation reprend une fois.
 */
async function prepareWithLocalFallback(p, cand, signal, opts = {}) {
  try {
    return await prepareView(p, cand, signal, false, opts);
  } catch (err) {
    if (signal.aborted || cand.view.fromShare !== true) throw err;
    return prepareView(p, cand, signal, true, opts);
  }
}

/** `opts.fresh` : la reconnexion redemande le lien au débrideur pour chaque candidat (voir resolveMedia). */
export async function playView(view, startAt, opts = {}) {
  const p = S.P;
  if (!p) return;
  const token = p.token;
  const playId = (p.playId = (p.playId || 0) + 1);
  const stale = () => !S.P || S.P.token !== token || S.P.playId !== playId;
  if (p.race) { p.race.cancel(); p.race = null; }
  p.view = view;
  p.tried.add(view.index);
  p.attempts += 1;
  p.defaultsDone = false;
  p.applier.reset();
  p.autoToast = false;
  p.learnToast = false;
  p.extSettled = false;
  p.toastBusyUntil = 0;
  clearTimeout(p.nativeApplyTimer);
  clearTimeout(p.learnTimer);
  clearTimeout(p.learnShowTimer);
  clearTimeout(p.learnNativeTimer);
  p.failing = false;
  p.localFailed = false;
  p.autoNexting = false;
  p.analyzed = false;
  p.hint = null;
  p.startAt = startAt || 0;
  const s = p.subs;
  Object.assign(s, { selectedId: null, secondaryId: null, cues2: [], native2: false, shift2: 0, swapped: false, cues: [], nativeCues: [], native: false, external: [], offset: 0, rate: 1, rateId: 'none', shift: 0, rateHint: '', syncKey: '' });
  resetSubsLoad(s); // le chargement des sous-titres de l'ancienne source est périmé : celui de la nouvelle doit pouvoir démarrer
  stopAutoSync();
  if (S.thumbs) S.thumbs.reset();
  if (S.feed) S.feed.reset();
  if (S.rangeFeed) S.rangeFeed.reset();
  p.reloading = true;
  stopWebAudio(p);
  if (p.engine) { try { if (p.engine.kind === 'native') p.engine.detach(); else p.engine.destroy(); } catch (_) { /* ignoré */ } }
  S.ui.setError(null);
  S.ui.root.classList.remove('is-searching');
  p.phase = nextPhase(p.phase, 'open');
  S.ui.setPhase(p.phase);
  syncTicks(); // le moteur est détruit, la phase repasse à « loading » : le démarrage doit être surveillé même si la boucle dormait (pause, onglet caché)
  const line = (v) => sourceLine(v) + (v.status === 'cached' ? ' ⚡' : '');
  if (isOfflineView(view)) { await playLocal(p, view, startAt, stale); return; }
  S.ui.setLoading(p.meta.title || 'Lecture', 'Préparation du lien…', loaderExtra(2, { source: line(view), ...(p.memStart ? { steps: MEMORY_STEPS } : {}) }));
  // Course : la source choisie démarre seule ; passé 6 s, la suivante part en parallèle, la première prête gagne (12 s au plus
  // par candidat, 25 s ou 3 échecs au total).
  const race = raceCandidates({
    first: { view, direct: false },
    next: (tried) => nextCandidate(p, tried),
    run: (cand, signal) => prepareWithLocalFallback(p, cand, signal, { fresh: opts.fresh === true }),
    onProgress: ({ attempt, max, slow, candidate }) => {
      if (stale() || !slow) return;
      p.view = listed(p, candidate.view);
      const msg = 'Ça prend du temps… ' + (candidate.direct ? 'essai en lecture directe' : 'essai d’une autre source') + ' (' + attempt + '/' + max + ')';
      S.ui.setLoading(p.meta.title || 'Lecture', msg, loaderExtra(2, { source: line(candidate.view), slow: true }));
    },
  });
  p.race = race;
  let win;
  try {
    win = await race.promise;
  } catch (err) {
    if (stale() || (err && err.kind === 'cancelled')) return;
    p.race = null;
    // Source mémorisée morte ou trop lente : recherche complète, sans erreur visible (la source n'est pas marquée mauvaise : son lien a pu expirer).
    if (p.memStart) { searchInstead(p, startAt); return; }
    const failures = (err && err.failures) || [];
    failures.forEach((f) => markBad(badKey(p), sourceKey(f.candidate.view), f.message));
    p.view = null;
    showSourcesPanel(failures.map((f) => describeView(f.candidate.view) + (f.candidate.direct ? ' (lecture directe)' : '') + ' : ' + f.message));
    return;
  }
  if (stale()) return;
  p.race = null;
  recordRace(p, win);
  // La liste complète a pu arriver pendant la course : la vue mémorisée est remplacée par sa fiche de la liste (mêmes indices que le panneau).
  p.view = listed(p, win.candidate.view);
  p.tried.add(p.view.index);
  try {
    await startPlan(p, win.value, startAt, stale, win.candidate);
  } catch (err) {
    if (stale()) return;
    failover(err && err.message ? err.message : 'Impossible de lancer la lecture');
  }
}

/**
 * Fichier téléchargé (ODY-203) : ni course de sources, ni sonde, ni serveur de streaming. Le moteur de la plateforme ouvre l'adresse locale
 * (URL d'objet pour le navigateur, `file://` pour libVLC, chemin pour mpv).
 */
async function playLocal(p, view, startAt, stale) {
  try {
    const sh = await connectShell();
    const native = !sh && isNativePlayer();
    const choice = chooseEngine({
      shell: !!sh, native, serverUp: false, probe: null, caps: getCaps(), notWebReady: false, name: view.filename || p.local.url,
      local: { name: view.filename, container: view.container },
    });
    if (stale()) return;
    if (choice.unsupported) { localFailure('container', choice.unsupported); return; }
    await startPlan(p, { shell: sh, media: { url: p.local.url, up: false, base: '' }, probe: null, choice, conversion: 'none', hlsUrl: null, hlsId: '', direct: false }, startAt, stale, null);
  } catch (err) {
    if (!stale()) localFailure('error', err && err.message);
  }
}

export function releaseLocal(p) {
  if (!p || !p.local) return;
  try { p.local.release(); } catch (_) { /* ignoré */ }
  p.local = null;
}

/** Charge la source préparée dans le moteur choisi. */
async function startPlan(p, plan, startAt, stale, cand) {
  const { shell, media, probe, choice } = plan;
  p.directNotified = !!(cand && cand.direct);
  p.mediaUrl = media.url;
  p.mediaBase = media.base;
  p.mediaUp = !!media.up;
  p.mediaProxied = media.proxied === true;
  p.probe = probe;
  p.probeTracks = parseProbe(probe);
  p.choice = choice;
  if (choice.engine === 'external') { openExternal(p, choice, media.url); return; } // lecteur externe : ni moteur, ni progression
  if (!isOfflineView(p.view)) refreshAddonThumbs();
  p.conversion = plan.conversion;
  p.startedAt = Date.now();
  p.watch = new StallWatch(p.startedAt);
  S.ui.root.classList.toggle('is-mpv', choice.engine === 'mpv' || choice.engine === 'native');
  // Lecteur natif : transparent dès le départ (comme avant). mpv : transparent seulement à la première image (MpvEngine.showVideo).
  S.ui.root.classList.toggle('is-video', choice.engine === 'native' || (choice.engine === 'mpv' && !!S.mpv && S.mpv.transparent));
  S.ui.setMiniAvailable(true);
  if (S.nativeMini && choice.engine !== 'native') { S.nativeMini = false; if (S.nativeEng) S.nativeEng.closeNow(); miniState.reset(); }
  S.ui.relayoutMini();
  // Les addons encore en recherche alimentent la liste de sources pendant la lecture (tous moteurs).
  pollMoreSources(p);
  if (choice.engine === 'native') {
    if (!S.nativeEng) { S.nativeEng = new NativeEngine(NativePlayer); bindEngine(S.nativeEng); }
    p.engine = S.nativeEng;
    S.ui.video.hidden = true;
    await S.nativeEng.load({ url: media.url, startAt, open: nativeOptions() });
  } else if (choice.engine === 'mpv') {
    if (!S.mpv) { S.mpv = new MpvEngine(shell, S.ui.root); bindEngine(S.mpv); }
    p.engine = S.mpv;
    S.ui.video.hidden = true;
    await S.mpv.load({ url: media.url, startAt });
    if (miniState.mini && S.lastMiniRect) S.mpv.setMini(S.lastMiniRect);
  } else {
    p.engine = S.html;
    S.ui.video.hidden = false;
    p.hlsQuery = plan.hlsUrl ? hlsQuery(media.url, getCaps(), p.forceHls) : '';
    p.hlsId = plan.hlsId;
    p.mediaBase = media.base;
    await S.html.load({ url: plan.hlsUrl || media.url, hls: !!plan.hlsUrl, startAt });
    // Web sans serveur de streaming : si le navigateur ne décode pas la piste son, l'app la joue elle-même (voir ./webaudio).
    if (!plan.hlsUrl && !shell && !isNativePlayer()) beginWebAudio(p, media.url, stale);
  }
  if (stale()) return;
  p.reloading = false;
  p.memStart = false;
  // Relance (ODY-206) : la source qui vient de démarrer est mémorisée pour la prochaine fois (choix manuel compris), sauf en salon.
  if (!isOfflineView(p.view) && !p.noLaunchCache && !p.partySwitch && !p.addon) {
    rememberLaunch(requestKey(p.req), { source: sourceKey(p.view), stream: p.view.stream, imdb: p.imdb || p.req.imdb || '', lang: launchLang(p) });
  }
  S.ui.setPipAvailable(p.engine.supportsPip());
  castSourceChanged(p);
  S.ui.setSeries(hasEpisodesPanel(p), !!nextRef());
  S.ui.setMarkAvailable(markAllowed(p));
  if (cand && cand.direct) toastBusy(p, 'Lecture directe : piste audio par défaut. Pour une autre langue, choisis-la dans Audio (transcodage).', 7000);
  if (p.notice) { toastBusy(p, p.notice, 6000); p.notice = ''; }
  refreshUI();
  partyBridge.viewReady(partyAdapter(p));
  p.partySwitch = false;
}

/** Libellé du son dans la fiche de lecture quand l'app ne laisse pas le navigateur le jouer. */
export const AUDIO_MODE_LABEL = { app: 'Son décodé par l’app (le navigateur ne le lit pas)', unsupported: 'Non pris en charge par le navigateur', error: 'Indisponible : la source répond trop lentement', cors: 'Indisponible : la source refuse la lecture du son par le navigateur' };

export function stopWebAudio(p) {
  if (p.webAudio) { try { p.webAudio.dispose(); } catch (_) { /* ignoré */ } p.webAudio = null; }
  p.audioMode = null;
  p.audioNote = '';
  if (S.ui) S.ui.setSoundNote('');
}

/** Codecs lus dans l'en-tête d'une autre source (plages seulement) : sert à proposer une source au son lisible. */
async function probeViewHeader(view, signal) {
  const url = await resolveRelayUrl(view, signal);
  if (!url || signal.aborted) return null;
  return probeHeaderUrl(url);
}

/** Moteur audio de repli (web, lecture directe) : lancé sans attendre, la vidéo démarre pendant la sonde. */
function beginWebAudio(p, url, stale) {
  const view = p.view;
  startWebAudio({
    video: S.ui.video,
    caps: getCaps(),
    attach: (fb) => S.html.attachAudio(fb),
    onChange: () => { S.html.emit('state'); },
    toast: (m, ms, action) => S.ui.toast(m, ms, action),
    alternatives: () => (p.ranked || []).filter((v) => !p.fallbackFilter || p.fallbackFilter(v)),
    currentIndex: () => (p.view ? p.view.index : null),
    probeView: probeViewHeader,
    describe: describeView,
    play: (v) => { if (S.P === p) playView(v, p.engine ? p.engine.state().time : 0); },
    setMode: (mode, note, link) => { p.audioMode = mode; p.audioNote = note; if (S.ui) { S.ui.setSoundNote(mode && mode !== 'app' ? note : '', link); S.ui.refreshPanel(); } },
  }, { url, nameCodec: fileCodecsOf(view).audio, stale }).then((h) => {
    if (stale()) h.dispose(); else p.webAudio = h;
  }).catch(() => undefined);
}
