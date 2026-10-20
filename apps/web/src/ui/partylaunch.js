/* Bouton « Watch party » de la fiche : choix du type de salon. Deux départs : le salon d'attente (Social v3 : le salon est créé
 * tout de suite, les participants arrivent et préparent leur source, l'hôte lance avec un compte à rebours), ou la lecture
 * immédiate (le salon est créé dès que la source est choisie, l'empreinte de la version lue en fait partie ; le lien
 * d'invitation est alors copié, voir src/party/bridge.ts). Un profil enfant ou hors compte garde la lecture immédiate. */
import { isKidProfile } from '../data/auth';
import { partyBridge, partyVisibilityChoices } from '../party/bridge';
import { auth, isServerMode } from '../data/auth';
import { modalBody } from './dom.js';
import { closeModal, openModal } from './modal.js';
import { createLobbyFor } from './partylobby.js';
import { playFrom, requestFrom } from './sources-ui.js';
import { state } from './state.js';
import { esc } from './util.js';

let opener = null;

export function partyDialogHTML(kid, lobby = false) {
  const choices = partyVisibilityChoices(kid);
  return '<h2 id="modal-title" class="wp-dlg-t">Watch party</h2>' +
    '<p class="tv-form-note">La lecture démarre et un salon est créé : tes amis te rejoignent avec le lien. Chacun lit avec sa propre source.</p>' +
    '<form class="wp-dlg" data-wp-launch><fieldset class="wp-fs"><legend>Type de salon</legend>' +
    '<label class="wp-opt"><input type="radio" name="vis" value="private" checked><span><b>Privé</b> Accessible seulement avec le lien.</span></label>' +
    (choices.includes('public') ? '<label class="wp-opt"><input type="radio" name="vis" value="public"><span><b>Public</b> Listé dans « Watch parties ».</span></label>' : '') +
    '</fieldset>' + (kid ? '<p class="tv-form-note">Profil enfant : salon privé uniquement.</p>' : '') +
    '<div class="tv-form-actions">' + (lobby
      ? '<button type="submit" class="btn btn-primary" data-wp-mode="lobby">' + esc('Ouvrir le salon d’attente') + '</button>' +
        '<button type="submit" class="btn btn-ghost" data-wp-mode="direct">' + esc('Lancer tout de suite') + '</button>'
      : '<button type="submit" class="btn btn-primary" data-wp-mode="direct">' + esc('Lancer la watch party') + '</button>') + '</div></form>';
}

/** Le salon d'attente demande un compte Laststream et un profil adulte. */
const canUseLobby = () => isServerMode() && auth.profile !== null && !isKidProfile();

export function openPartyDialog(btn) {
  opener = btn;
  openModal(partyDialogHTML(isKidProfile(), canUseLobby()), btn, '');
}

modalBody.addEventListener('submit', (e) => {
  const f = e.target instanceof Element ? e.target.closest('[data-wp-launch]') : null;
  if (!f) return;
  e.preventDefault();
  const sel = f.querySelector('input[name="vis"]:checked');
  const visibility = sel && sel.value === 'public' && !isKidProfile() ? 'public' : 'private';
  const btn = opener;
  const mode = e.submitter instanceof HTMLElement ? e.submitter.dataset.wpMode : 'direct';
  closeModal(true);
  if (!btn) return;
  const req = mode === 'lobby' && canUseLobby() ? requestFrom(btn) : null;
  if (req && !btn.dataset.playKey) {
    const m = state.model;
    void createLobbyFor(req, (m && m.posterPath) || null, visibility, btn);
    return;
  }
  partyBridge.pending = { visibility };
  playFrom(btn);
});
