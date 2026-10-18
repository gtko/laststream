/* Bouton « Watch party » de la fiche : choix du type de salon, puis lecture. Le salon est créé dès que la source est choisie
 * (l'empreinte de la version lue en fait partie) ; le lien d'invitation est alors copié, voir src/party/bridge.ts. */
import { isKidProfile } from '../data/auth';
import { partyBridge, partyVisibilityChoices } from '../party/bridge';
import { modalBody } from './dom.js';
import { closeModal, openModal } from './modal.js';
import { playFrom } from './sources-ui.js';
import { esc } from './util.js';

let opener = null;

export function partyDialogHTML(kid) {
  const choices = partyVisibilityChoices(kid);
  return '<h2 id="modal-title" class="wp-dlg-t">Watch party</h2>' +
    '<p class="tv-form-note">La lecture démarre et un salon est créé : tes amis te rejoignent avec le lien. Chacun lit avec sa propre source.</p>' +
    '<form class="wp-dlg" data-wp-launch><fieldset class="wp-fs"><legend>Type de salon</legend>' +
    '<label class="wp-opt"><input type="radio" name="vis" value="private" checked><span><b>Privé</b> Accessible seulement avec le lien.</span></label>' +
    (choices.includes('public') ? '<label class="wp-opt"><input type="radio" name="vis" value="public"><span><b>Public</b> Listé dans « Watch parties ».</span></label>' : '') +
    '</fieldset>' + (kid ? '<p class="tv-form-note">Profil enfant : salon privé uniquement.</p>' : '') +
    '<div class="tv-form-actions"><button type="submit" class="btn btn-primary">' + esc('Lancer la watch party') + '</button></div></form>';
}

export function openPartyDialog(btn) {
  opener = btn;
  openModal(partyDialogHTML(isKidProfile()), btn, '');
}

modalBody.addEventListener('submit', (e) => {
  const f = e.target instanceof Element ? e.target.closest('[data-wp-launch]') : null;
  if (!f) return;
  e.preventDefault();
  const sel = f.querySelector('input[name="vis"]:checked');
  const visibility = sel && sel.value === 'public' && !isKidProfile() ? 'public' : 'private';
  const btn = opener;
  closeModal(true);
  if (!btn) return;
  partyBridge.pending = { visibility };
  playFrom(btn);
});
