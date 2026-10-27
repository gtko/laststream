/* Création de l'interface du lecteur (une seule fois), mini-lecteur, coque Windows et branchement des événements du moteur. */
import { HtmlEngine } from './engines.js';
import { MINI_ON_EXIT_KEY, exitMode, minimizeExits, miniOnExitEnabled } from './mini';
import { connectShell, setShellFullscreen, startShellDrag } from './shell';
import { hlsMasterUrl, newSessionId, serverBase } from './server';
import { Thumbs } from './thumbview.js';
import { debrid, PROVIDER_LABEL } from '../sources/debridClient';
import { createPlayerUI } from './ui.js';
import { createMessageBubble } from './messageBubble';
import { openConversation } from '../ui/socialSidebar.js';
import { mountPartyPanel } from '../ui/partypanel.js';
import { getState as getSocialState, sendMessage as sendSocialMessage, subscribe as subscribeSocial } from '../data/socialStore';
import { onAction, onKey, panelData, playEpisode, seekTo, sendSegment, togglePlay } from './sessionActions.js';
import { closePlayer } from './sessionClose.js';
import { failover } from './sessionFailover.js';
import { externalAfterError } from './externalScreen.js';
import { onNativeSource, onNativeTrack, syncNative } from './sessionNative.js';
import { ensureEpisodes } from './sessionOpen.js';
import { deleteReaction, editReaction, onCinema, partyAdapter, postReact, socialHidden } from './sessionSocial.js';
import { S, AUTOPIP_KEY, getCaps, miniState, storeGet, storeSet } from './sessionState.js';
import { addonThumb, cancelAddonThumb, rangeThumb, thumbsAllowedNow, thumbSourceOf } from './sessionThumbs.js';
import * as playerState from './playerState';
import { nudgeTick, onEnded, refreshUI, saveProgress, syncTicks, ticksAsleep } from './sessionTick.js';
import { ensureExternalSubs, onReady, onTracks } from './sessionTracks.js';


export function ensureUI() {
  if (S.ui) return;
  S.ui = createPlayerUI({
    action: (act, data) => { onAction(act, data); nudgeTick(); },
    seekTo: (t) => seekTo(t),
    setVolume: (v) => { if (S.P && S.P.engine) { S.P.engine.setMuted(false); S.P.engine.setVolume(v); rememberVolume(v); } },
    panelData,
    panelOpened: (name) => {
      if (name === 'tracks') ensureExternalSubs();
      if (name === 'episodes') ensureEpisodes(S.P && S.P.cur.season, true);
    },
    // Fermer le panneau des sources sans avoir choisi (recherche initiale) annule la lecture : retour à la fiche.
    panelClosed: (name) => { if (name === 'sources' && S.P && !S.P.view) closePlayer(); },
    thumb: (t) => {
      if (!S.P || !S.P.view) return;
      const mode = thumbSourceOf(S.P).mode;
      if (mode === 'range') rangeThumb(t);
      else if (mode === 'addon') addonThumb(t);
      else if (S.thumbs) S.thumbs.request(t);
    },
    thumbCancel: () => { if (S.thumbs) S.thumbs.cancel(); cancelAddonThumb(); },
    miniState,
    miniLayout: onMiniLayout,
    react: postReact,
    myPid: () => { const me = getSocialState().me; return me ? me.pid : null; },
    editNote: editReaction,
    deleteNote: deleteReaction,
    markSend: (kind, start, end) => sendSegment(kind, start, end, false),
    cinema: onCinema,
  });
  miniState.onChange(applyMini);
  // Bascule automatique entre débrideurs : « AllDebrid indisponible → TorBox ».
  debrid().setHandlers({ onSwitch: (from, to) => S.ui.toast(PROVIDER_LABEL[from] + ' indisponible → ' + PROVIDER_LABEL[to], 6000) });
  mountPartyPanel(S.ui.root, { adapter: () => partyAdapter() });
  S.thumbs = new Thumbs(S.ui.thumbCanvas, {
    allowed: () => thumbsAllowedNow(),
    duration: () => (S.P && S.P.engine ? S.P.engine.state().duration : 0),
    // Vidéo d'aperçu : lien direct, ou seconde session HLS basse résolution du serveur (jamais celle de la lecture).
    source: async () => {
      const p = S.P;
      const src = thumbSourceOf(p);
      if (src.mode === 'direct') return { url: p.mediaUrl, hls: false };
      if (src.mode === 'hls') return { url: hlsMasterUrl(p.mediaBase || serverBase(), newSessionId(), p.mediaUrl, getCaps(), src.forceTranscoding, src.maxWidth), hls: true };
      return null;
    },
  });
  S.html = new HtmlEngine(S.ui.video);
  bindEngine(S.html);
  bindShell();
  const v = Number(storeGet('laststream.player.volume'));
  if (Number.isFinite(v) && storeGet('laststream.player.volume') !== null) S.ui.video.volume = Math.min(1, Math.max(0, v));
  S.ui.video.autoPictureInPicture = storeGet(AUTOPIP_KEY) === '1';
  S.ui.setPipAvailable(S.html.supportsPip());
  document.addEventListener('keydown', onKey, true);
  S.bubble = createMessageBubble(S.ui.root, {
    getState: getSocialState, subscribe: subscribeSocial, send: sendSocialMessage, openConversation,
    enabled: () => !socialHidden().has('bubbles'),
  });
  // Image dans l'image : pas de barre de titre, on déplace la fenêtre en glissant sur la vidéo (hors boutons et barre de lecture).
  S.ui.root.addEventListener('mousedown', (e) => {
    if (!S.shell || !S.shellPip || e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest('button, input, [data-seek]')) return;
    e.preventDefault();
    startShellDrag(S.shell);
  }, true);
  document.addEventListener('fullscreenchange', () => { if (S.P) refreshUI(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && S.P) saveProgress(true);
    if (S.P) syncTicks(); // caché : boucles arrêtées (moteur web) ; de retour : elles repartent
  });
  window.addEventListener('pagehide', () => { if (S.P) saveProgress(true); });
  // Retour du navigateur pendant la lecture : même règle que la flèche (lecture en cours réduite, sinon fermée) ; la page derrière a déjà navigué.
  window.addEventListener('popstate', () => { if (S.P && S.P.view && !miniState.mini) leavePlayer(); });
}

// ---------- Mini-lecteur ----------

/** Réduction possible : une source est en lecture, moteur web ou mpv (le lecteur natif Android a son image dans l'image système). */
export const canMinimize = () => !!S.P && !!S.P.view && !!S.P.engine && !(S.shell && S.shellPip);

export function minimizePlayer() {
  if (!canMinimize()) return false;
  // Plein écran (document ou fenêtre de la coque) quitté d'abord : la vignette serait sinon perdue dans l'écran.
  const exits = minimizeExits({ docFullscreen: !!document.fullscreenElement, shell: !!S.shell, shellFullscreen: S.shellFullscreen });
  if (exits.exitDoc) document.exitFullscreen().catch(() => {});
  if (exits.exitShell) { S.shellFullscreen = false; setShellFullscreen(S.shell, false); }
  saveProgress(true);
  const native = S.P.engine.kind === 'native';
  const ok = miniState.minimize();
  // Lecteur natif Android : la vignette est une vue native ; si elle n'est pas disponible (télévision), on revient au plein écran.
  if (ok && native) S.P.engine.minimize().then((on) => { if (!on && S.nativeMini) { S.nativeMini = false; miniState.expand(); } });
  return ok;
}

/**
 * Retour (flèche, Échap, retour du navigateur ou du téléphone) : une lecture en cours se réduit en miniature, sans clic
 * préalable sur « Réduire » ; en pause, terminée, sans source ou réglage désactivé, le lecteur se ferme.
 */
export function leavePlayer() {
  if (!S.P) return;
  const st = S.P.view && S.P.engine ? S.P.engine.state() : null;
  const mode = exitMode({
    canMinimize: canMinimize(),
    enabled: miniOnExitEnabled(storeGet(MINI_ON_EXIT_KEY)),
    paused: !!(st && st.paused),
    ended: !!(st && st.ended) || !!S.P.finished,
  });
  if (mode === 'minimize' && minimizePlayer()) return;
  closePlayer();
}

export function expandPlayer() {
  if (S.nativeMini && S.nativeEng) S.nativeEng.expand();
  return miniState.expand();
}

/** Remise à zéro du mini-lecteur à chaque nouvelle session ; la vignette native, elle, accueille le média suivant sans repasser en plein écran. */
export function resetMini() {
  if (S.nativeMini) return;
  miniState.reset();
}

/** Nouvelle position de la vignette : mpv recale son image (marges) et la page est percée au même endroit. */
function onMiniLayout(video) {
  S.lastMiniRect = video;
  if (S.mpv) S.mpv.setMini(video);
}

/** Bascule visuelle réduit / plein lecteur (la lecture, elle, n'est jamais interrompue). */
function applyMini(on) {
  if (!S.ui) return;
  S.nativeMini = on && !!S.P && !!S.P.engine && S.P.engine.kind === 'native';
  S.ui.root.classList.toggle('is-native-mini', S.nativeMini);
  S.ui.setMini(on);
  playerState.set({ mini: on });
  document.body.classList.toggle('modal-open', !on && !!S.P);
  if (on) {
    const a = document.activeElement;
    if (a instanceof HTMLElement && S.ui.root.contains(a)) a.blur();
    const opener = S.P && S.P.opener;
    if (opener && opener.isConnected && opener.focus) opener.focus({ preventScroll: true });
  } else {
    if (S.mpv) S.mpv.setMini(null);
    S.lastMiniRect = null;
    if (S.P) { S.ui.wake(); S.ui.focusFirst(); }
  }
}

/** Événements de la coque : touches multimédia (lecture/pause, piste suivante) et état plein écran de la fenêtre. */
function bindShell() {
  connectShell().then((t) => {
    if (!t) return;
    S.shell = t;
    t.on('media-key', (action) => {
      if (!S.P || !S.P.view) return;
      if (action === 'play-pause') togglePlay();
      else if (action === 'next-track') onAction('next');
      else if (action === 'previous-track') seekTo(0);
    });
    t.on('win-visibility-changed', (v) => { if (v && typeof v.isFullscreen === 'boolean') { S.shellFullscreen = v.isFullscreen; if (S.P) refreshUI(); } });
    t.on('win-pip-changed', (v) => {
      if (!v || typeof v.pip !== 'boolean') return;
      S.shellPip = v.pip;
      if (S.shellPip) S.shellFullscreen = false;
      if (S.ui) S.ui.root.classList.toggle('is-pip', S.shellPip);
      if (S.P) refreshUI();
    });
    t.on('win-set-visibility', (v) => { if (v && typeof v.fullscreen === 'boolean') { S.shellFullscreen = v.fullscreen; if (S.P) refreshUI(); } });
  });
}

export const rememberVolume = (v) => storeSet('laststream.player.volume', String(v));

export function bindEngine(e) {
  let wasPaused = null;
  e.on('state', () => {
    if (!S.P || S.P.engine !== e) return;
    refreshUI();
    // Lecteur natif : la pause se fait dans son panneau, sans passer par la session ; la position est enregistrée à cet instant.
    const st = e.state();
    const paused = !!st.paused;
    if (e.kind === 'native' && paused && wasPaused === false) saveProgress(true);
    if (paused !== wasPaused) syncTicks(); // play / pause : les boucles repartent ou s'arrêtent
    else if (paused) nudgeTick(); // saut en pause : le sous-titre suit
    else if (ticksAsleep()) saveProgress(false, st); // onglet caché pendant la lecture : la progression passe par les événements du moteur
    wasPaused = paused;
  });
  e.on('ended', () => { if (S.P && S.P.engine === e) onEnded(); });
  e.on('error', (err) => {
    if (!S.P || S.P.engine !== e) return;
    const msg = err && err.message ? err.message : 'inconnue';
    if (externalAfterError(S.P, msg)) return; // iPhone et iPad : format ou décodage refusé par le lecteur intégré → lecteur externe, sans changer de source
    failover('Erreur de lecture (' + msg + ')');
  });
  e.on('tracks', () => { if (S.P && S.P.engine === e) onTracks(); });
  e.on('ready', () => { if (S.P && S.P.engine === e) onReady(); });
  // Lecteur natif Android : fermeture par l'utilisateur, bouton « Épisode suivant », changement de piste dans le panneau natif.
  e.on('closed', () => { if (S.P && S.P.engine === e) closePlayer(); });
  e.on('next', () => { if (S.P && S.P.engine === e) onAction('next'); });
  e.on('trackChanged', (d) => { if (S.P && S.P.engine === e) onNativeTrack(d); });
  // Vignette native : réduite ou agrandie depuis le natif (tap, bouton retour, geste), l'état web suit.
  e.on('mini', (on) => { if (S.P && S.P.engine === e) { if (on) { saveProgress(true); miniState.minimize(); } else { S.nativeMini = false; miniState.expand(); } } });
  e.on('selectSource', (d) => { if (S.P && S.P.engine === e) onNativeSource(d); });
  e.on('selectEpisode', (d) => { if (S.P && S.P.engine === e) playEpisode(Number(d.season), Number(d.episode)); });
  e.on('loadSeason', (d) => { if (S.P && S.P.engine === e) ensureEpisodes(Number(d.season)).then(syncNative); });
}
