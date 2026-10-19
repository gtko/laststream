/* Page invitée d'une watch party : #/party/join/<id>?t=<jeton>. Accessible sans compte (main.js ne lance pas l'écran de connexion
 * pour cette adresse). L'invité choisit un pseudo, rejoint le salon, reçoit la lecture de l'hôte par WebRTC et la décode ici.
 * Le lien débridé ne quitte jamais l'appareil de l'hôte : seules les plages de fichier arrivent. Aucune URL n'est affichée. */
import { requireBase } from '../data/config';
import { enterPartyAsGuest } from '../data/socialApi';
import { UserApiError } from '../data/userApi';
import { socketUrl } from '../party/bridge';
import { cleanPseudo, clearGuestSession, entryErrorText, guestWsPath, hashWithoutToken, loadGuestSession, saveGuestSession } from '../party/join';
import { GuestRelaySession } from '../relay/session';
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

let session = null;
let timer = null;
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
  subsOff?.();
  subsOff = null;
  subs?.setTracks([]);
  chat?.unbind();
  if (session) session.destroy();
  session = null;
  lastView = null;
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

function refresh(root) {
  if (!session || !controls) return;
  const v = session.tick();
  lastView = v;
  exposeStats(session);
  // Salon accepté (bienvenue reçue) : la phase n'est plus « joining » ni terminale.
  if (v.phase !== 'joining' && !TERMINAL.has(v.phase)) dropTokenFromUrl();
  const status = root.querySelector('[data-pj-status]');
  // Le message de la session (et la note sur le son) ; la phase « prête » ajoute une ligne d'explication.
  status.textContent = [v.message || (v.phase === 'ready' ? READY_TEXT : ''), v.note].filter(Boolean).join(' ');
  status.dataset.tone = WARN.has(v.phase) ? 'warn' : '';
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
  controls.setWait(ready ? null : WAIT_TEXT[v.phase] || null);
  // Champs sans source dans la session : codecs et tampon restent « — ».
  controls.setInfo({
    rate: v.rateBps,
    bytesHost: v.bytesReceived,
    bytesPeers: v.bytesFromPeers,
    videoCodec: null,
    audioCodec: null,
    bufferAhead: null,
  });
  root.querySelector('[data-pj-retry]').hidden = v.phase !== 'host-lost';
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
      const res = await enterPartyAsGuest(roomId, token, name);
      entry = { sessionToken: res.sessionToken, name: res.name, expiresAt: res.expiresAt };
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
    createPlayer: (callbacks) => new GuestPlayer(callbacks),
    canvas: root.querySelector('[data-pj-canvas]'),
  });
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
    '<header class="pj-head"><h1 class="pj-title" id="pj-title" tabindex="-1">Watch party</h1><p class="pj-who" data-pj-who hidden></p></header>' +
    '<p class="pj-note">Tu as reçu une invitation. Pas besoin de compte : choisis un pseudo et rejoins le salon.</p>' +
    '<form class="pj-form" data-pj-form autocomplete="off">' +
    '<label class="pj-field">Pseudo<input name="name" type="text" maxlength="32" autocomplete="nickname" value="' + esc(loadGuestSession(roomId)?.name || '') + '" required></label>' +
    '<button type="submit" class="btn btn-primary" data-pj-join>Rejoindre</button></form>' +
    '<p class="pj-msg" role="status" data-pj-status></p>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-pj-leave hidden>Quitter</button>' +
    '<div class="pj-player" data-pj-player hidden>' +
    '<div class="pj-stage" data-pj-stage><canvas class="pj-canvas" data-pj-canvas aria-label="Vidéo du salon"></canvas></div>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-pj-retry hidden>Réessayer la liaison avec l’hôte</button></div>' +
    '</section>';
  const root = detailEl.querySelector('.pj');
  const stage = root.querySelector('[data-pj-stage]');
  // Commandes : les actions passent par le salon (play/pause/saut) ; volume et sourdine restent masqués (rien à régler côté lecteur).
  controls = createGuestControls(stage, {
    onPlay: () => session?.play(),
    onPause: () => session?.pause(),
    onSeek: (t) => {
      if (session && lastView) session.seekBy(t - lastView.position);
    },
  });
  // Sous-titres et chat : le menu des sous-titres et le tiroir du chat ne se superposent pas (chacun ferme l'autre à l'ouverture).
  subs = createGuestSubs(controls, { onOpen: () => chat?.close() });
  chat = createGuestChat(controls, { onOpen: () => subs?.closeMenu() });
  root.querySelector('#pj-title').focus({ preventScroll: true });
  root.querySelector('[data-pj-form]').addEventListener('submit', (e) => {
    e.preventDefault();
    join(root, roomId, token);
  });
  root.querySelector('[data-pj-retry]').addEventListener('click', () => session?.retry());
  root.querySelector('[data-pj-leave]').addEventListener('click', () => leave(root));
}
