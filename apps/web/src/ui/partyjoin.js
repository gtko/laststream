/* Page invitée d'une watch party : #/party/join/<id>?t=<jeton>. Accessible sans compte (main.js ne lance pas l'écran de connexion
 * pour cette adresse). L'invité choisit un pseudo, rejoint le salon, reçoit la lecture de l'hôte par WebRTC et la décode ici.
 * Le lien débridé ne quitte jamais l'appareil de l'hôte : seules les plages de fichier arrivent. Aucune URL n'est affichée. */
import { requireBase } from '../data/config';
import { enterPartyAsGuest } from '../data/socialApi';
import { UserApiError } from '../data/userApi';
import { socketUrl } from '../party/bridge';
import { GUEST_AVATARS, guestAvatarToSend, initialGuestAvatar, saveGuestAvatar } from '../party/guestAvatar';
import { createBufferReporter, isUnderrun } from '../party/guestbuffer';
import { cleanPseudo, clearGuestSession, entryErrorText, guestWsPath, hashWithoutToken, loadGuestSession, saveGuestSession, waitingHostText } from '../party/join';
import { GuestRelaySession } from '../relay/session';
import { avatarAttrs } from './avatar-art.js';
import { detailEl } from './dom.js';
import { createGuestChat } from './guestchat.js';
import { createGuestControls } from './guestplayer.js';
import { createGuestSubs } from './guestsubs.js';
import { esc } from './util.js';

/** Phases où la session ne fait plus rien : on rend la main au formulaire. « unsupported » ne l'est pas : l'hôte peut changer de fichier. */
const TERMINAL = new Set(['refused', 'ended', 'left']);
/** Phases où le cadre vidéo et ses commandes sont affichés (attente comprise). */
const STAGE = new Set(['joining', 'waiting-host', 'connecting-host', 'loading', 'ready', 'host-lost']);
/** Phases qui méritent un ton d'alerte sous le formulaire. */
const WARN = new Set(['unsupported', 'host-lost', 'refused', 'ended']);
/** Bandeau central pendant l'attente (la phase « prête » n'en a pas). */
const WAIT_TEXT = {
  joining: 'Connexion au salon…',
  'waiting-host': 'En attente de l’hôte…',
  'connecting-host': 'Connexion à l’hôte…',
  loading: 'Ouverture de la lecture…',
  'host-lost': 'Liaison avec l’hôte interrompue',
};
const READY_TEXT = 'Lecture partagée prête : pause, reprise et sauts valent pour tout le salon.';
/** Durée d'affichage d'un message d'état en salon (toast), en ms. Une alerte (WARN) reste affichée. */
const TOAST_MS = 4000;

let session = null;
let timer = null;
/** Minuterie qui masque le message d'état (toast) du salon. */
let statusTimer = null;
let audioCtx = null;
/** Vrai pendant le chargement du lecteur (évite un second envoi du formulaire). */
let joining = false;
/** Salon dont la séance d'invité est en cours (effacée quand la session se termine : exclusion, salon fini, refus). */
let currentRoom = '';
/** Dernière vue de la session (position courante, pour les sauts absolus demandés par les commandes). */
let lastView = null;
/** Commandes du cadre vidéo de la page affichée (créées par showPartyJoin, détruites au changement de page). */
let controls = null;
/** Sous-titres et chat du cadre (créés avec les commandes) ; abonnement aux pistes de l'hôte de la session en cours. */
let subs = null;
let chat = null;
let subsOff = null;
/** Attente de tampon du salon (`PartyWait`, ou null), rapport de tampon du lecteur en cours et ce lecteur (statistiques, volume). */
let roomWait = null;
let bufferReporter = null;
let livePlayer = null;

/** Geste utilisateur (clic « Rejoindre ») : l'AudioContext démarre ici, le lecteur peut ensuite jouer le son. */
function unlockAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = new Ctx();
    void audioCtx.resume().catch(() => undefined);
  } catch {
    audioCtx = null;
  }
}

function closeAudio() {
  if (audioCtx) void audioCtx.close().catch(() => undefined);
  audioCtx = null;
}

function stopSession() {
  if (timer !== null) clearInterval(timer);
  timer = null;
  clearTimeout(statusTimer);
  statusTimer = null;
  subsOff?.();
  subsOff = null;
  subs?.setTracks([]);
  chat?.unbind();
  if (session) session.destroy();
  session = null;
  lastView = null;
  roomWait = null;
  bufferReporter = null;
  livePlayer = null;
  closeAudio();
}

function destroyControls() {
  subs?.destroy();
  subs = null;
  chat?.destroy();
  chat = null;
  controls?.destroy();
  controls = null;
}

/** Arrête la page invitée (changement de route, nouvelle invitation). */
export function teardownPartyJoin() {
  stopSession();
  destroyControls();
}

/** Retire le jeton de l'adresse une fois le salon rejoint : il ne reste que dans la session (ni historique ni copie d'écran). */
function dropTokenFromUrl() {
  try {
    const hash = location.hash || '';
    if (/\?t=/.test(hash)) history.replaceState(null, '', location.pathname + location.search + hashWithoutToken(hash));
  } catch {
    // sans effet : l'adresse garde le jeton
  }
}

/** Diagnostic des tests de bout en bout (lecture seule, nombres seulement) : actif seulement si `localStorage['ls.debug']` vaut 1. */
function exposeStats(s) {
  let on = false;
  try {
    on = globalThis.localStorage?.getItem('ls.debug') === '1';
  } catch {
    on = false;
  }
  if (on) window.__lsRelayStats = Object.freeze(s.debugCounts());
}

/** Affiche le pseudo sous le titre, une fois le salon rejoint (texte seul, jamais de balisage). */
function setWho(root, name) {
  const who = root.querySelector('[data-pj-who]');
  if (!who) return;
  who.textContent = name ? 'Pseudo : ' + name : '';
  who.hidden = !name;
}

/** Message d'état. En salon, une information disparaît après TOAST_MS ; une alerte (WARN) reste affichée. Avant de rejoindre, le
 * message reste sous le formulaire, comme avant. Le texte n'est réécrit (et la minuterie relancée) que s'il change. */
function paintStatus(root, text, warn) {
  const status = root.querySelector('[data-pj-status]');
  status.dataset.tone = warn ? 'warn' : '';
  if (status.textContent === text) return;
  status.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = null;
  delete status.dataset.fade;
  if (text && !warn && root.classList.contains('is-joined')) {
    statusTimer = setTimeout(() => {
      statusTimer = null;
      status.dataset.fade = 'out';
    }, TOAST_MS);
  }
}

function refresh(root) {
  if (!session || !controls) return;
  const v = session.tick();
  lastView = v;
  exposeStats(session);
  // Salon accepté (bienvenue reçue) : la phase n'est plus « joining » ni terminale.
  if (v.phase !== 'joining' && !TERMINAL.has(v.phase)) dropTokenFromUrl();
  // Le message de la session (et la note sur le son) ; la phase « prête » ajoute une ligne d'explication.
  const text = [v.message || (v.phase === 'ready' ? READY_TEXT : ''), v.note].filter(Boolean).join(' ');
  // Salon rejoint (hors fin de séance) : cadre plein écran et en-tête compact ; le message d'état devient un toast.
  root.classList.toggle('is-joined', !TERMINAL.has(v.phase));
  paintStatus(root, text, WARN.has(v.phase) || (v.phase === 'waiting-host' && v.message !== waitingHostText()));
  const form = root.querySelector('[data-pj-form]');
  const submit = root.querySelector('[data-pj-join]');
  const leave = root.querySelector('[data-pj-leave]');
  const player = root.querySelector('[data-pj-player]');
  if (TERMINAL.has(v.phase)) {
    // Séance finie ou refusée : le jeton de séance ne sert plus, le prochain essai repasse par le lien partagé.
    if (currentRoom) clearGuestSession(currentRoom);
    stopSession();
    controls.setState({ playing: false, ready: false });
    controls.setWait(null);
    player.hidden = true;
    form.hidden = false;
    submit.textContent = v.phase === 'left' ? 'Rejoindre à nouveau' : 'Rejoindre';
    leave.hidden = true;
    return;
  }
  form.hidden = true;
  leave.hidden = false;
  player.hidden = !STAGE.has(v.phase);
  const ready = v.phase === 'ready';
  controls.setState({ playing: v.playing, position: v.position, duration: v.duration, ready });
  subs?.tick(v.position);
  controls.setWait(ready ? roomWaitText(roomWait) : WAIT_TEXT[v.phase] || null);
  // Infos réelles du lecteur (octets reçus de l'hôte et des pairs, codecs, tampon) ; le débit vient de la session.
  const gs = livePlayer ? livePlayer.stats() : null;
  controls.setInfo({
    rate: v.rateBps,
    bytesHost: gs ? gs.bytesFromHost : v.bytesReceived,
    bytesPeers: gs ? gs.bytesFromPeers : v.bytesFromPeers,
    videoCodec: gs ? gs.videoCodec : null,
    audioCodec: gs ? gs.audioCodec : null,
    bufferAhead: gs ? gs.bufferAhead : null,
  });
  // Sous-alimentation : la lecture roule alors que le tampon est sous le seuil (spinner central).
  controls.setBuffering(ready && !!gs && isUnderrun({ ahead: gs.bufferAhead, playing: v.playing, remaining: v.duration > 0 ? v.duration - v.position : undefined }));
  root.querySelector('[data-pj-retry]').hidden = v.phase !== 'host-lost';
}

/** Bandeau d'attente du salon : les retardataires, par pseudo ; null quand personne n'attend. */
function roomWaitText(wait) {
  return wait && wait.who.length > 0 ? 'En attente de ' + wait.who.join(', ') + '…' : null;
}

/** Lecteur de la lecture en cours, créé à chaque chargement (join, reconnexion, nouveau fichier) : son rapport de tampon repart
 * donc de l'attente. Un saut local l'y remet ; la fermeture du lecteur libère le salon. */
/** Couleur de fond des avatars de la grille (les invités n'ont pas de couleur de profil). */
const GRID_COLOR = '#64748b';

/** Grille de choix d'avatar (boutons radio) ; l'illustration est posée par avatar-art.js sur [data-avatar]. */
export function guestAvatarGridHTML(selected) {
  return '<fieldset class="pj-avs" data-pj-avatars><legend>Ton avatar</legend><div class="pj-avgrid" role="radiogroup" aria-label="Avatar">' +
    GUEST_AVATARS.map((value) => '<button type="button" role="radio" class="pj-av" data-pj-av="' + esc(value) + '" aria-checked="' + (value === selected ? 'true' : 'false') + '"' +
      ' aria-label="Avatar ' + (GUEST_AVATARS.indexOf(value) + 1) + '"><span class="pj-avi"' + avatarAttrs(value, GRID_COLOR) + '></span></button>').join('') +
    '</div></fieldset>';
}

function newPlayer(GuestPlayer, callbacks) {
  const reporter = createBufferReporter({
    send: (ready, ahead) => session?.sendBuffering(ready, ahead),
    now: () => Date.now(),
  });
  const player = new GuestPlayer({
    ...callbacks,
    onBuffer: (ahead) => {
      const st = player.getState();
      reporter.update({
        ahead,
        playing: st.playing,
        seeking: false,
        remaining: st.duration > 0 ? st.duration - st.position : undefined,
        resumeAhead: roomWait?.resumeAhead,
      });
    },
    onUserSeek: (pos) => {
      reporter.reset();
      callbacks.onUserSeek?.(pos);
    },
  });
  const destroy = player.destroy.bind(player);
  player.destroy = () => {
    reporter.stop();
    if (bufferReporter === reporter) bufferReporter = null;
    if (livePlayer === player) livePlayer = null;
    destroy();
  };
  bufferReporter = reporter;
  livePlayer = player;
  // Volume mémorisé sur cet appareil : le curseur affiche la valeur du lecteur.
  controls?.setVolume({ volume: player.getVolume(), muted: player.isMuted() });
  return player;
}

/** Clic « Rejoindre » : geste utilisateur, AudioContext, puis lecteur chargé à la demande (il pèse : mediabunny). */
async function join(root, roomId, token) {
  if (joining || session) return;
  const name = cleanPseudo(root.querySelector('[name="name"]').value);
  const status = root.querySelector('[data-pj-status]');
  if (!name) {
    status.textContent = 'Choisis un pseudo (32 caractères au plus).';
    return;
  }
  let base;
  try {
    base = requireBase();
  } catch {
    status.textContent = 'Serveur Laststream non configuré sur cet appareil.';
    return;
  }
  unlockAudio();
  joining = true;
  // Lien partagé : le jeton du lien s'échange (une fois) contre un jeton de séance individuel, réutilisé aux reconnexions.
  let entry = loadGuestSession(roomId);
  if (!entry) {
    status.textContent = 'Entrée dans le salon…';
    try {
      const chosen = guestAvatarToSend(root.querySelector('[data-pj-av][aria-checked="true"]')?.getAttribute('data-pj-av'));
      const res = await enterPartyAsGuest(roomId, token, name, chosen);
      if (chosen) saveGuestAvatar(chosen);
      entry = { sessionToken: res.sessionToken, name: res.name, expiresAt: res.expiresAt, ...(res.avatar ? { avatar: res.avatar } : chosen ? { avatar: chosen } : {}) };
      saveGuestSession(roomId, entry);
    } catch (err) {
      joining = false;
      closeAudio();
      status.textContent = entryErrorText(err instanceof UserApiError ? err.code : 'network');
      return;
    }
  }
  status.textContent = 'Chargement du lecteur…';
  let GuestPlayer;
  try {
    ({ GuestPlayer } = await import('../relay/player/player'));
  } catch {
    joining = false;
    status.textContent = 'Lecteur indisponible : recharge la page.';
    return;
  }
  joining = false;
  // La page a pu changer pendant le chargement : rien à lancer.
  if (!root.isConnected) {
    closeAudio();
    return;
  }
  currentRoom = roomId;
  const url = socketUrl(base, guestWsPath(roomId, entry.sessionToken, entry.name));
  session = new GuestRelaySession({
    connect: async () => new WebSocket(url),
    createPlayer: (callbacks) => newPlayer(GuestPlayer, callbacks),
    canvas: root.querySelector('[data-pj-canvas]'),
  });
  // Attente de tampon du salon (retardataires) ; bienvenue à chaque (re)connexion : le tampon repart de l'attente.
  session.onWait((wait) => {
    roomWait = wait;
  });
  session.onWelcome(() => bufferReporter?.reset());
  setWho(root, entry.name || name);
  session.start();
  subsOff = session.onSubtitles((tracks) => subs?.setTracks(tracks));
  chat?.bind(session.chatPort());
  timer = setInterval(() => refresh(root), 250);
  refresh(root);
}

/** Clic « Quitter » : le WebSocket, le relais, le maillage et le lecteur se ferment ; la page propose de rejoindre à nouveau. */
function leave(root) {
  if (!session) return;
  session.leave();
  refresh(root);
}

/** Affiche la page d'invitation (remplace le contenu de la vue détail). */
export function showPartyJoin(roomId, token) {
  stopSession();
  destroyControls();
  detailEl.innerHTML = '<section class="pj" aria-labelledby="pj-title">' +
    '<header class="pj-head"><h1 class="pj-title" id="pj-title" tabindex="-1">Watch party</h1><p class="pj-who" data-pj-who hidden></p>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-pj-retry hidden aria-label="Réessayer la liaison avec l’hôte">Réessayer</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-pj-leave hidden>Quitter</button></header>' +
    '<p class="pj-note">Tu as reçu une invitation. Pas besoin de compte : choisis un pseudo et rejoins le salon.</p>' +
    '<form class="pj-form" data-pj-form autocomplete="off">' +
    '<label class="pj-field">Pseudo<input name="name" type="text" maxlength="32" autocomplete="nickname" value="' + esc(loadGuestSession(roomId)?.name || '') + '" required></label>' +
    (loadGuestSession(roomId) ? '' : guestAvatarGridHTML(initialGuestAvatar())) +
    '<button type="submit" class="btn btn-primary" data-pj-join>Rejoindre</button></form>' +
    '<p class="pj-msg" role="status" data-pj-status></p>' +
    '<div class="pj-player" data-pj-player hidden>' +
    '<div class="pj-stage" data-pj-stage><canvas class="pj-canvas" data-pj-canvas aria-label="Vidéo du salon"></canvas></div></div>' +
    '</section>';
  const root = detailEl.querySelector('.pj');
  const stage = root.querySelector('[data-pj-stage]');
  // Commandes : les actions passent par le salon (play/pause/saut) ; volume et sourdine règlent le son de cet appareil.
  controls = createGuestControls(stage, {
    onPlay: () => session?.play(),
    onPause: () => session?.pause(),
    onSeek: (t) => {
      if (session && lastView) session.seekBy(t - lastView.position);
    },
    onVolume: (volume) => livePlayer?.setVolume(volume),
    onMute: (muted) => livePlayer?.setMuted(muted),
  });
  // Sous-titres et chat : le menu des sous-titres et le tiroir du chat ne se superposent pas (chacun ferme l'autre à l'ouverture).
  subs = createGuestSubs(controls, { onOpen: () => chat?.close() });
  chat = createGuestChat(controls, { onOpen: () => subs?.closeMenu() });
  root.querySelector('#pj-title').focus({ preventScroll: true });
  root.querySelector('[data-pj-form]').addEventListener('submit', (e) => {
    e.preventDefault();
    join(root, roomId, token);
  });
  root.querySelectorAll('[data-pj-av]').forEach((b) => b.addEventListener('click', () => {
    root.querySelectorAll('[data-pj-av]').forEach((o) => o.setAttribute('aria-checked', o === b ? 'true' : 'false'));
  }));
  root.querySelector('[data-pj-retry]').addEventListener('click', () => session?.retry());
  root.querySelector('[data-pj-leave]').addEventListener('click', () => leave(root));
}
