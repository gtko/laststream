/* Panneau « Watch party » du lecteur : création du salon, participants (rôle d'hôte, muet, exclusion), chat, réactions rapides.
 * La synchronisation de la lecture est dans src/party (contrôleur) ; ici, seulement l'interface. */
import { isKidProfile } from '../data/auth';
import { partyVisibilityChoices, partyBridge } from '../party/bridge';
import { joinLinkOf } from '../party/join';
import { partyErrorText, REACTIONS } from '../party/protocol';
import { UserApiError } from '../data/userApi';
import { toast } from './dom.js';
import { shareBase } from './invites.js';
import { esc } from './util.js';
import { avatarAttrs } from './avatar-art.js';

let rootEl = null;
let panel = null;
let floats = null;
let getAdapter = () => null;
let attached = null;
let open = false;
let chatDraft = '';
/** Dernier lien d'invitation créé pour le salon affiché (le jeton ne vit que dans ce panneau). */
let lastInviteUrl = '';

const fmtRate = (bps) => (bps / 1048576).toFixed(1).replace('.', ',') + ' Mo/s';
const guestCount = (c) => c.participants.filter((p) => p.guest).length;

/** Ligne d'état du partage aux invités (débit montant ; aucune URL). */
function relayText() {
  if (partyBridge.relayRefused()) return 'Ce lien ne peut pas être partagé depuis le navigateur : les invités ne reçoivent pas la vidéo.';
  const s = partyBridge.relayStats();
  if (!s) return 'Partage inactif : il démarre quand un invité est présent pendant la lecture.';
  return 'Envoi : ' + fmtRate(s.rateBps) + ' vers ' + s.links + ' invité' + (s.links > 1 ? 's' : '') + '.';
}

function inviteHTML(c) {
  return '<section class="wp-invite"><button type="button" class="btn btn-ghost btn-sm" data-wp-invite>Copier le lien d’invitation</button>' +
    (lastInviteUrl ? '<input type="text" class="wp-invite-link" data-wp-invite-link readonly value="' + esc(lastInviteUrl) + '" aria-label="Lien d’invitation">' : '') +
    '<p class="wp-note">Invités : <b data-wp-guests>' + guestCount(c) + '</b></p>' +
    '<p class="wp-note wp-warn">Chaque invité consomme ~ le débit du fichier en envoi depuis votre connexion.</p>' +
    '<p class="wp-note" data-wp-relay role="status">' + esc(relayText()) + '</p></section>';
}

/** Lien d'un salon (ouvre la page de connexion au salon). */
export const roomLink = (id) => shareBase().replace(/\/+$/, '') + '/#/party/' + encodeURIComponent(id);

const dot = (color, art) => '<span class="wp-dot"' + avatarAttrs(art, color) + ' aria-hidden="true"></span>';

export function participantsHTML(list, you, youHost) {
  return list.map((p) => {
    const me = you && p.username === you.username;
    const tools = youHost && !me
      ? '<span class="wp-tools"><button type="button" class="wp-mini" data-wp-mute="' + esc(p.username) + '" data-muted="' + (p.muted ? '1' : '0') + '">' + (p.muted ? 'Rétablir' : 'Muet') + '</button>' +
        '<button type="button" class="wp-mini" data-wp-host="' + esc(p.username) + '" title="Céder le rôle d’hôte">Hôte</button>' +
        '<button type="button" class="wp-mini wp-danger" data-wp-kick="' + esc(p.username) + '">Exclure</button></span>'
      : '';
    return '<li class="wp-user">' + dot(p.avatarColor, p.avatar) + '<span class="wp-name">' + esc(p.username) + (me ? ' (toi)' : '') + '</span>' +
      (p.host ? '<em class="wp-badge">Hôte</em>' : '') + (p.muted ? '<em class="wp-badge wp-badge-muted">Muet</em>' : '') + tools + '</li>';
  }).join('');
}

export function chatHTML(lines, you) {
  if (!lines.length) return '<p class="wp-empty">Aucun message pour l’instant.</p>';
  return lines.map((l) => {
    const mine = you && l.from === you.username;
    return '<p class="wp-line' + (mine ? ' is-mine' : '') + '" data-wp-line="' + esc(l.id) + '"><b>' + esc(l.from) + '</b> <span>' + esc(l.text) + '</span>' +
      (mine ? '' : '<button type="button" class="wp-flag" data-wp-report="' + esc(l.id) + '" aria-label="Signaler ce message" title="Signaler">⚑</button>') + '</p>';
  }).join('');
}

function createHTML() {
  const kid = isKidProfile();
  const choices = partyVisibilityChoices(kid);
  const a = getAdapter();
  const ready = !!(a && a.ready);
  return '<h3 class="wp-title">Watch party</h3>' +
    '<p class="wp-note">Regarde en même temps que tes amis. Chacun lit avec sa propre source : aucun lien de lecture n’est partagé.</p>' +
    '<form class="wp-form" data-wp-create><fieldset class="wp-fs"><legend>Type de salon</legend>' +
    '<label class="wp-opt"><input type="radio" name="vis" value="private" checked><span><b>Privé</b> Accessible seulement avec le lien.</span></label>' +
    (choices.includes('public') ? '<label class="wp-opt"><input type="radio" name="vis" value="public"><span><b>Public</b> Listé dans « Watch parties ».</span></label>' : '') +
    '</fieldset>' +
    (kid ? '<p class="wp-note">Profil enfant : salon privé uniquement.</p>' : '') +
    '<p class="wp-msg" data-wp-msg role="status">' + (ready ? '' : 'Attends que la lecture démarre pour créer le salon.') + '</p>' +
    '<button type="submit" class="btn btn-primary"' + (ready ? '' : ' disabled') + '>Créer le salon</button></form>';
}

function roomHTML(c) {
  const you = c.you;
  const host = !!(you && you.host);
  const status = c.status === 'open' ? '' : '<p class="wp-status" role="status">' + (c.status === 'closed' ? 'Déconnecté du salon.' : 'Connexion au salon… reprise automatique.') + '</p>';
  const room = c.room;
  return '<div class="wp-head"><h3 class="wp-title">' + esc(room ? room.title : 'Salon') + '</h3>' +
    '<span class="wp-vis">' + (room && room.visibility === 'public' ? 'Public' : 'Privé') + '</span></div>' + status +
    '<div class="wp-actions">' + (host ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-wp-copy>Copier le lien</button>') +
    '<button type="button" class="btn btn-ghost btn-sm" data-wp-leave>Quitter</button>' +
    (host ? '<button type="button" class="btn btn-ghost btn-sm wp-danger" data-wp-end>Terminer</button>' : '') + '</div>' +
    '<h4 class="wp-sub">Participants (' + c.participants.length + ')</h4><ul class="wp-users" data-wp-users>' + participantsHTML(c.participants, you, host) + '</ul>' +
    (host ? inviteHTML(c) : '') +
    (host ? '' : '<p class="wp-note">La lecture est partagée : pause, reprise et sauts valent pour tout le salon. Seul l’hôte change d’épisode.</p>') +
    '<h4 class="wp-sub">Chat</h4><div class="wp-chat" data-wp-chat role="log" aria-live="polite">' + chatHTML(c.chat, you) + '</div>' +
    '<form class="wp-send" data-wp-send><input type="text" name="text" maxlength="500" autocomplete="off" placeholder="' + (you && you.muted ? 'Tu es muet' : 'Écrire un message') + '"' + (you && you.muted ? ' disabled' : '') + ' value="' + esc(chatDraft) + '">' +
    '<button type="submit" class="btn btn-primary btn-sm"' + (you && you.muted ? ' disabled' : '') + '>Envoyer</button></form>' +
    '<div class="wp-react" role="group" aria-label="Réactions">' + REACTIONS.map((e) => '<button type="button" data-wp-react="' + e + '" aria-label="Réaction ' + e + '">' + e + '</button>').join('') + '</div>';
}

function render() {
  if (!panel) return;
  panel.hidden = !open;
  rootEl.classList.toggle('has-party-panel', open);
  if (!open) return;
  const c = partyBridge.client;
  const typing = panel.contains(document.activeElement) && document.activeElement.name === 'text';
  if (typing) chatDraft = document.activeElement.value;
  const chatBox = panel.querySelector('[data-wp-chat]');
  const keepScroll = chatBox ? chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 40 : true;
  panel.innerHTML = '<button type="button" class="wp-close" data-wp-close aria-label="Fermer le panneau">×</button>' + (c && c.status !== 'idle' ? roomHTML(c) : createHTML()) +
    (partyBridge.endReason ? '<p class="wp-msg" role="alert">' + esc(endText(partyBridge.endReason)) + '</p>' : '') +
    (partyBridge.lastError ? '<p class="wp-msg" role="alert">' + esc(partyBridge.lastError) + '</p>' : '');
  const box = panel.querySelector('[data-wp-chat]');
  if (box && keepScroll) box.scrollTop = box.scrollHeight;
  if (typing) {
    const input = panel.querySelector('input[name="text"]');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }
}

const endText = (r) => (r === 'kicked' ? 'Tu as été exclu du salon.' : r === 'ended' ? 'Le salon est terminé.' : r === 'replaced' ? 'Connexion reprise depuis un autre appareil.' : r === 'full' ? 'Le salon est complet.' : 'Salon fermé.');

function floatReaction(emoji, user) {
  if (!floats) return;
  const s = document.createElement('span');
  s.className = 'wp-float';
  s.style.left = 8 + Math.random() * 80 + '%';
  s.textContent = emoji;
  s.title = user;
  floats.appendChild(s);
  setTimeout(() => s.remove(), 3200);
}

/** Rafraîchit seulement les compteurs (sans reconstruire le panneau) : débit montant et nombre d'invités. */
function updateRelayLine() {
  if (!panel || !open) return;
  const relay = panel.querySelector('[data-wp-relay]');
  if (relay) relay.textContent = relayText();
  const c = partyBridge.client;
  const guests = panel.querySelector('[data-wp-guests]');
  if (guests && c) guests.textContent = String(guestCount(c));
}

function attach() {
  const c = partyBridge.client;
  if (c === attached) return;
  attached = c;
  lastInviteUrl = '';
  if (!c) return;
  c.on('chat', () => render());
  c.on('removed', () => render());
  c.on('react', (r) => floatReaction(r.emoji, r.user));
  c.on('host', (user) => { toast(user + ' est maintenant l’hôte'); render(); });
  c.on('muted', () => render());
  c.on('reported', (r) => { if (r.against) toast('Signalement reçu : ' + r.against); else toast('Message signalé, merci'); });
  c.on('error', (code) => toast(partyErrorText(code)));
  c.on('end', (reason) => { toast(endText(reason)); render(); });
}

/** Crée le panneau dans la racine du lecteur (une seule fois). `opts.adapter` : titre en cours de lecture. */
export function mountPartyPanel(root, opts) {
  if (rootEl) return;
  rootEl = root;
  getAdapter = opts.adapter;
  panel = document.createElement('aside');
  panel.className = 'lp-party';
  panel.setAttribute('aria-label', 'Watch party');
  panel.hidden = true;
  floats = document.createElement('div');
  floats.className = 'lp-party-floats';
  floats.setAttribute('aria-hidden', 'true');
  root.appendChild(floats);
  root.appendChild(panel);
  partyBridge.onChange(() => { attach(); render(); });
  partyBridge.onCreated = (room) => { copyLink(room.id); togglePartyPanel(true); };
  panel.addEventListener('click', onClick);
  panel.addEventListener('submit', onSubmit);
  setInterval(updateRelayLine, 1000);
}

export function togglePartyPanel(force) {
  open = typeof force === 'boolean' ? force : !open;
  partyBridge.lastError = '';
  attach();
  render();
}

export const isPartyPanelOpen = () => open;

async function onSubmit(e) {
  const f = e.target;
  if (!(f instanceof HTMLFormElement)) return;
  e.preventDefault();
  e.stopPropagation();
  if (f.matches('[data-wp-send]')) {
    const c = partyBridge.client;
    const text = f.elements.text.value;
    if (c && c.sendChat(text)) { chatDraft = ''; f.elements.text.value = ''; }
    return;
  }
  if (f.matches('[data-wp-create]')) {
    const a = getAdapter();
    const msg = f.querySelector('[data-wp-msg]');
    if (!a || !a.ready) return;
    const vis = (f.querySelector('input[name="vis"]:checked') || {}).value === 'public' ? 'public' : 'private';
    f.querySelector('[type=submit]').disabled = true;
    try {
      const room = await partyBridge.create(a, vis);
      await copyLink(room.id);
    } catch (err) {
      f.querySelector('[type=submit]').disabled = false;
      if (msg) msg.textContent = err instanceof UserApiError && err.code === 'too_many_rooms' ? 'Tu as déjà trois salons ouverts : termine-en un d’abord.'
        : err instanceof UserApiError && err.code === 'kid_profile' ? 'Un profil enfant ne crée que des salons privés.' : 'Création du salon impossible pour le moment.';
    }
  }
}

async function copyText(url, okText) {
  try {
    await navigator.clipboard.writeText(url);
    toast(okText);
    return true;
  } catch {
    toast('Copie impossible : ' + url, { ms: 6000 });
    return false;
  }
}

export function copyLink(id) {
  return copyText(roomLink(id), 'Lien du salon copié');
}

/** Crée un lien d'invitation (hôte seulement), le copie et l'affiche dans le panneau. */
async function invite() {
  try {
    const inv = await partyBridge.createInvite();
    lastInviteUrl = joinLinkOf(shareBase(), inv.roomId, inv.token);
    await copyText(lastInviteUrl, 'Lien d’invitation copié');
  } catch (err) {
    toast(err instanceof UserApiError && err.code === 'not_host' ? 'Seul l’hôte peut inviter.' : 'Invitation impossible pour le moment.');
  }
  render();
}

function onClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  e.stopPropagation();
  const c = partyBridge.client;
  if (t.closest('[data-wp-close]')) { togglePartyPanel(false); return; }
  if (t.closest('[data-wp-invite]') && c) { void invite(); return; }
  if (t.closest('[data-wp-copy]') && c && c.room) { copyLink(c.room.id); return; }
  if (t.closest('[data-wp-leave]')) { partyBridge.leave(); toast('Tu as quitté le salon'); return; }
  if (t.closest('[data-wp-end]')) {
    if (window.confirm('Terminer le salon pour tous les participants ?')) partyBridge.end();
    return;
  }
  const react = t.closest('[data-wp-react]');
  if (react && c) { c.react(react.dataset.wpReact); return; }
  const mute = t.closest('[data-wp-mute]');
  if (mute && c) { c.mute(mute.dataset.wpMute, mute.dataset.muted !== '1'); return; }
  const host = t.closest('[data-wp-host]');
  if (host && c) { if (window.confirm('Céder le rôle d’hôte à ' + host.dataset.wpHost + ' ?')) c.transfer(host.dataset.wpHost); return; }
  const kick = t.closest('[data-wp-kick]');
  if (kick && c) { if (window.confirm('Exclure ' + kick.dataset.wpKick + ' du salon ?')) c.kick(kick.dataset.wpKick); return; }
  const rep = t.closest('[data-wp-report]');
  if (rep && c) { c.report(rep.dataset.wpReport, 'chat'); }
}
