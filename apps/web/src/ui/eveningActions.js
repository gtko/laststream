/* Confirmations des soirées planifiées (LAST-199, lot B) : annuler une soirée, arrêter une série (hôte), quitter une soirée ou une
 * série (invité). Une feuille de confirmation, un seul envoi à la fois, l'erreur du serveur expliquée dans la feuille. Une réponse
 * tardive (feuille fermée, profil changé) n'écrit plus rien. */
import { auth } from '../data/auth';
import { eveningErrorText } from '../data/eveningForm';
import { commitEvening } from '../data/eveningsStore';
import { cancelEvening, leaveEvening, stopEveningSeries } from '../data/socialV3Api';
import { toast } from './dom.js';
import { openSheet } from './sheet.js';
import { esc } from './util.js';

const COPY = {
  cancel: { title: 'Annuler cette soirée ?', ok: 'Annuler la soirée', keep: 'Garder', done: 'Soirée annulée.', danger: true,
    text: (e) => '« ' + e.title + ' » sera annulée pour tous les invités, qui en seront prévenus.' },
  stop: { title: 'Arrêter la série ?', ok: 'Arrêter la série', keep: 'Garder', done: 'Série arrêtée.', danger: true,
    text: (e) => 'Les prochaines soirées de « ' + e.title + ' » seront annulées pour tous les invités.' },
  leave: { title: 'Quitter cette soirée ?', ok: 'Quitter', keep: 'Rester', done: 'Tu as quitté la soirée.', danger: false,
    text: (e) => 'Tu ne viendras pas à « ' + e.title + ' ». L’hôte en sera prévenu.' },
};

/** Types d'action de confirmation. */
export const CONFIRM_KINDS = Object.keys(COPY);

/**
 * Ouvre la confirmation `kind` (cancel | stop | leave) pour la soirée `ev`. Quitter une soirée récurrente propose « cette soirée
 * seulement » ou « toute la série ».
 * @param {'cancel' | 'stop' | 'leave'} kind
 * @param {any} ev
 * @param {Element | null} opener
 */
export function openEveningAction(kind, ev, opener) {
  const c = COPY[kind];
  if (!c) return null;
  const pid0 = auth.profile ? auth.profile.id : '';
  const series = kind === 'leave' && !!(ev.recurrence || ev.seriesId);
  let busy = false;
  const sheet = openSheet({
    title: c.title,
    cls: 'evc-sheet',
    opener,
    locked: () => busy,
    initialFocus: '[data-sheet-close]',
    html: '<p class="evc-text">' + esc(c.text(ev)) + '</p>' +
      (series ? '<fieldset class="evf-scope"><legend class="sr-only">Portée</legend><label><input type="radio" name="scope" value="occurrence" checked> Cette soirée seulement</label>' +
        '<label><input type="radio" name="scope" value="series"> Toute la série</label></fieldset>' : '') +
      '<p class="evf-err evf-server" data-evc-err role="alert" hidden></p>' +
      '<div class="evf-foot"><button type="button" class="btn btn-ghost evf-btn" data-sheet-close>' + esc(c.keep) + '</button>' +
      '<button type="button" class="btn evf-btn ' + (c.danger ? 'evc-danger' : 'btn-primary') + '" data-evc-ok>' + esc(c.ok) + '</button></div>',
  });
  const ok = sheet.el.querySelector('[data-evc-ok]');
  const err = sheet.el.querySelector('[data-evc-err]');
  if (!(ok instanceof HTMLButtonElement) || !(err instanceof HTMLElement)) return sheet;
  ok.addEventListener('click', () => {
    if (busy || sheet.closed) return;
    const picked = sheet.el.querySelector('input[name="scope"]:checked');
    const scope = picked instanceof HTMLInputElement && picked.value === 'series' ? 'series' : 'occurrence';
    busy = true;
    ok.disabled = true;
    ok.setAttribute('aria-busy', 'true');
    err.hidden = true;
    const run = kind === 'cancel' ? () => cancelEvening(ev.id, 'occurrence') : kind === 'stop' ? () => stopEveningSeries(ev.id) : () => leaveEvening(ev.id, scope);
    commitEvening(run, kind === 'stop' || scope === 'series' ? undefined : ev.id).then(
      (done) => {
        if (sheet.closed) return;
        if (!done || (auth.profile ? auth.profile.id : '') !== pid0) { sheet.close(true); return; }
        toast(kind === 'leave' && scope === 'series' ? 'Tu as quitté la série.' : c.done);
        sheet.close();
      },
      (e) => {
        if (sheet.closed) return;
        if ((auth.profile ? auth.profile.id : '') !== pid0) { sheet.close(true); return; }
        busy = false;
        ok.disabled = false;
        ok.removeAttribute('aria-busy');
        err.textContent = eveningErrorText(e);
        err.hidden = false;
      },
    );
  });
  return sheet;
}
