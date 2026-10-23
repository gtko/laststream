/* Bouton « Watch party » de la fiche : boîte de lancement (maquettes Salon / Partage, Social v3). Carte du titre avec son affiche,
 * visibilité en segments (Privé / Public), amis à inviter tout de suite, puis « Ouvrir le salon d'attente » (salon créé tout de suite,
 * les participants arrivent et préparent leur source, l'hôte lance avec un compte à rebours) ou « Lancer tout de suite » (le salon
 * est créé dès que la source est choisie, l'empreinte de la version lue en fait partie ; voir src/party/bridge.ts).
 * Un profil enfant ou hors compte garde la lecture immédiate, en salon privé, sans invitations. Mobile : panneau du bas. */
import { auth, isKidProfile, isServerMode } from '../data/auth';
import { partyBridge, partyVisibilityChoices } from '../party/bridge';
import { modalBody } from './dom.js';
import { closeModal, openModal } from './modal.js';
import { runOnce, TOGGLE_COOLDOWN_MS } from './busy.js';
import { createLobbyFor, inviteMany } from './partylobby.js';
import { handlePartyCreateError } from './partyerrors.js';
import { sortedFriends } from './partyfriends.js';
import { safeTmdbImage } from './safeImg.js';
import { playFrom, requestFrom } from './sources-ui.js';
import { avatarHTML, nameOf, SEEN_LABEL } from './socialFmt.js';
import { state } from './state.js';
import { esc } from './util.js';

let opener = null;
/** Titre de la boîte quand ce n'est pas celui de la fiche ouverte (menu contextuel d'une affiche) ; null : la fiche. */
let partyModel = null;

/** Le salon d'attente demande un compte Laststream et un profil adulte. */
const canUseLobby = () => isServerMode() && auth.profile !== null && !isKidProfile();

const ICON_USERS = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.3-5.5 6.5-5.5s5.9 1.9 6.5 5.5M17 5a3.5 3.5 0 0 1 0 7M18 14.8c2 .6 3.2 2.4 3.5 5.2"/></svg>';
const ICON_PLAY = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4v16l13-8z"/></svg>';

function titleCardHTML(model) {
  const name = model && model.name ? String(model.name) : 'Ce titre';
  const poster = model ? safeTmdbImage(model.posterPath, 'w185') : null;
  const kind = model && model.type === 'tv' ? 'Série' : 'Film';
  return '<div class="pld-card">' +
    (poster ? '<span class="pld-poster"><img src="' + esc(poster) + '" alt=""></span>' : '<span class="pld-poster is-empty" aria-hidden="true">' + ICON_PLAY + '</span>') +
    '<span class="pld-card-t"><span class="pl-lb">Watch party</span><b class="pld-name">' + esc(name) + '</b><span class="pld-sub">' + kind + ' · chacun lit avec sa propre source</span></span></div>';
}

function visibilityHTML(choices, kid) {
  const opt = (value, label, hint, on) => '<label class="pld-seg-o"><input type="radio" name="vis" value="' + value + '"' + (on ? ' checked' : '') + '><span><b>' + esc(label) + '</b><i>' + esc(hint) + '</i></span></label>';
  return '<fieldset class="pld-fs"><legend class="pl-lb">Qui peut rejoindre</legend><div class="pld-seg">' +
    opt('private', 'Privé', kid ? 'Profil enfant : salon privé uniquement' : 'Amis invités', true) +
    (choices.includes('public') ? opt('public', 'Public', 'Listé dans « Watch parties »', false) : '') + '</div></fieldset>';
}

function friendsHTML() {
  const friends = sortedFriends();
  if (!friends.length) return '<div class="pld-sec"><div class="pl-lb">Inviter des amis</div><p class="pl-empty pld-empty">Aucun ami pour l’instant : tu pourras partager le lien depuis le salon.</p></div>';
  return '<div class="pld-sec"><div class="pl-lb">Inviter des amis maintenant</div><ul class="pld-friends">' + friends.map((f) =>
    '<li><label class="pld-friend">' + avatarHTML(f, 'ss-av-m', f.status === 'offline' ? '' : f.status) +
    '<span class="pld-friend-t"><b>' + esc(nameOf(f)) + '</b><span>' + (f.watching ? 'Regarde ' + esc(f.watching.title) : esc(SEEN_LABEL[f.status] || 'Hors ligne')) + '</span></span>' +
    '<input type="checkbox" name="friend" value="' + esc(f.pid) + '" aria-label="Inviter ' + esc(nameOf(f)) + '"><span class="pld-check" aria-hidden="true"></span></label></li>').join('') + '</ul></div>';
}

/** Contenu de la boîte. `lobby` : le salon d'attente est possible (compte Laststream, profil adulte). */
export function partyDialogHTML(kid, lobby = false, model = state.model) {
  const choices = partyVisibilityChoices(kid);
  return '<form class="pld" data-wp-launch><h2 id="modal-title" class="sr-only">Watch party</h2>' + titleCardHTML(model) + visibilityHTML(choices, kid) +
    (lobby ? friendsHTML() : '<p class="pld-note">La lecture démarre et un salon est créé : tes amis te rejoignent avec le lien.</p>') +
    '<div class="pld-actions">' + (lobby
      ? '<button type="submit" class="pl-btn is-pri is-lg" data-wp-mode="lobby">' + ICON_USERS + esc('Ouvrir le salon d’attente') + '</button>' +
        '<button type="submit" class="pld-link" data-wp-mode="direct">' + esc('Lancer tout de suite') + '</button>'
      : '<button type="submit" class="pl-btn is-pri is-lg" data-wp-mode="direct">' + ICON_PLAY + esc('Lancer la watch party') + '</button>') + '</div></form>';
}

/**
 * Fenêtre de lancement d'une watch party. `model` : titre de la fenêtre (menu contextuel d'une affiche) ; sans lui, c'est la fiche ouverte.
 * @param {object | null} [model]
 */
export function openPartyDialog(btn, model = null) {
  opener = btn;
  partyModel = model;
  openModal(partyDialogHTML(isKidProfile(), canUseLobby(), model || state.model), btn, 'pld-modal');
  const first = modalBody.querySelector('.pld input[type="radio"]:checked');
  if (first instanceof HTMLElement) first.focus();
}

// Salon créé à la volée (« Lancer tout de suite ») : amis choisis invités, échec expliqué (PIN redemandé si besoin).
partyBridge.onInvites = (room, pids) => { void partyBridge.waitForHost().then((ok) => { if (ok) return inviteMany(room.id, pids); }); };
partyBridge.onCreateError = (err, retry, cancel) => { void handlePartyCreateError(err, { retry, cancel }); };

modalBody.addEventListener('submit', (e) => {
  const f = e.target instanceof Element ? e.target.closest('[data-wp-launch]') : null;
  if (!f) return;
  e.preventDefault();
  const sel = f.querySelector('input[name="vis"]:checked');
  const visibility = sel && sel.value === 'public' && !isKidProfile() ? 'public' : 'private';
  const invite = canUseLobby() ? [...f.querySelectorAll('input[name="friend"]:checked')].map((i) => i.value) : [];
  const btn = opener;
  const model = partyModel;
  const mode = e.submitter instanceof HTMLElement ? e.submitter.dataset.wpMode : 'direct';
  closeModal(true);
  if (!btn) return;
  const req = mode === 'lobby' && canUseLobby() ? requestFrom(btn, model) : null;
  if (req && (model || !btn.dataset.playKey)) {
    const m = model || state.model;
    // Pas deux salons pour un même titre sur un double envoi.
    void runOnce('party-create:' + req.key, () => createLobbyFor(req, (m && m.posterPath) || null, visibility, btn, invite), { cooldown: TOGGLE_COOLDOWN_MS, maxMs: 60000 });
    return;
  }
  partyBridge.pending = { visibility };
  partyBridge.pendingInvites = invite;
  playFrom(btn, model);
});
