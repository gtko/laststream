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
import { esc } from './util.js';

/** Phases où la session ne fait plus rien : on rend la main au formulaire. */
const TERMINAL = new Set(['refused', 'ended', 'unsupported']);
const PHASE_TEXT = {
  joining: 'Connexion au salon…',
  'waiting-host': '',
  'connecting-host': 'Connexion à l’hôte…',
  loading: 'Ouverture de la lecture…',
  ready: 'Lecture partagée prête : pause, reprise et sauts valent pour tout le salon.',
  'host-lost': '',
  refused: '',
  unsupported: '',
  ended: '',
};

let session = null;
let timer = null;
let audioCtx = null;
/** Vrai pendant le chargement du lecteur (évite un second envoi du formulaire). */
let joining = false;
/** Salon dont la séance d'invité est en cours (effacée quand la session se termine : exclusion, salon fini, refus). */
let currentRoom = '';

const fmtRate = (bps) => (bps / 1048576).toFixed(1).replace('.', ',') + ' Mo/s';
const clock = (s) => {
  const t = Math.max(0, Math.floor(s || 0));
  return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
};

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
  if (session) session.destroy();
  session = null;
  closeAudio();
}

/** Arrête la page invitée (changement de route, nouvelle invitation). */
export function teardownPartyJoin() {
  stopSession();
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

function refresh(root) {
  if (!session) return;
  const v = session.tick();
  // Salon accepté (bienvenue reçue) : la phase n'est plus « joining » ni terminale.
  if (v.phase !== 'joining' && !TERMINAL.has(v.phase)) dropTokenFromUrl();
  const status = root.querySelector('[data-pj-status]');
  // La note (son non pris en charge) s'ajoute à la ligne d'état, sans remplacer le texte de la phase.
  status.textContent = [v.message || PHASE_TEXT[v.phase] || '', v.note].filter(Boolean).join(' ');
  const form = root.querySelector('[data-pj-form]');
  if (TERMINAL.has(v.phase)) {
    // Séance finie ou refusée : le jeton de séance ne sert plus, le prochain essai repasse par le lien partagé.
    if (currentRoom) clearGuestSession(currentRoom);
    stopSession();
    form.hidden = false;
    return;
  }
  form.hidden = true;
  const player = root.querySelector('[data-pj-player]');
  player.hidden = !['loading', 'ready', 'host-lost'].includes(v.phase);
  const ready = v.phase === 'ready';
  for (const sel of ['[data-pj-play]', '[data-pj-pause]', '[data-pj-back]', '[data-pj-fwd]']) root.querySelector(sel).disabled = !ready;
  root.querySelector('[data-pj-retry]').hidden = v.phase !== 'host-lost';
  root.querySelector('[data-pj-meta]').textContent = clock(v.position) + ' / ' + clock(v.duration) + (ready ? ' · Débit reçu : ' + fmtRate(v.rateBps) : '');
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
  session.start();
  timer = setInterval(() => refresh(root), 250);
  refresh(root);
}

/** Affiche la page d'invitation (remplace le contenu de la vue détail). */
export function showPartyJoin(roomId, token) {
  stopSession();
  detailEl.innerHTML = '<section class="pj" aria-labelledby="pj-title">' +
    '<h1 class="pj-title" id="pj-title" tabindex="-1">Watch party</h1>' +
    '<p class="pj-note">Tu as reçu une invitation. Pas besoin de compte : choisis un pseudo et rejoins le salon.</p>' +
    '<form class="pj-form" data-pj-form autocomplete="off">' +
    '<label class="pj-field">Pseudo<input name="name" type="text" maxlength="32" autocomplete="nickname" value="' + esc(loadGuestSession(roomId)?.name || '') + '" required></label>' +
    '<button type="submit" class="btn btn-primary" data-pj-join>Rejoindre</button></form>' +
    '<p class="pj-msg" role="status" data-pj-status></p>' +
    '<div class="pj-player" data-pj-player hidden>' +
    '<canvas class="pj-canvas" data-pj-canvas aria-label="Vidéo du salon"></canvas>' +
    '<div class="pj-controls" role="group" aria-label="Lecture">' +
    '<button type="button" class="btn btn-ghost btn-sm" data-pj-back disabled>−10 s</button>' +
    '<button type="button" class="btn btn-primary btn-sm" data-pj-play disabled>Lecture</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-pj-pause disabled>Pause</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-pj-fwd disabled>+10 s</button></div>' +
    '<p class="pj-meta" data-pj-meta></p>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-pj-retry hidden>Réessayer la liaison avec l’hôte</button></div>' +
    '</section>';
  const root = detailEl.querySelector('.pj');
  root.querySelector('#pj-title').focus({ preventScroll: true });
  root.querySelector('[data-pj-form]').addEventListener('submit', (e) => {
    e.preventDefault();
    join(root, roomId, token);
  });
  root.querySelector('[data-pj-play]').addEventListener('click', () => session?.play());
  root.querySelector('[data-pj-pause]').addEventListener('click', () => session?.pause());
  root.querySelector('[data-pj-back]').addEventListener('click', () => session?.seekBy(-10));
  root.querySelector('[data-pj-fwd]').addEventListener('click', () => session?.seekBy(10));
  root.querySelector('[data-pj-retry]').addEventListener('click', () => session?.retry());
}
