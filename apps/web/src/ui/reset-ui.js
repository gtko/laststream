/* Page publique #/reset/<jeton> : choisir un nouveau mot de passe avec un lien du propriétaire (sans session).
 * S'affiche avant l'écran de connexion ; se résout quand l'utilisateur a terminé (ou abandonné). */
import { passwordIssue, resetTokenFromLocation } from '../data/reset';
import { passwordReset, UserApiError } from '../data/userApi';
import { brand } from './fragments.js';

export const resetToken = () => resetTokenFromLocation(location.search, location.hash, location.pathname);

function resetError(err) {
  if (!(err instanceof UserApiError)) return 'Une erreur est survenue.';
  switch (err.code) {
    case 'reset_invalid': return 'Ce lien est invalide, expiré ou déjà utilisé. Demande un nouveau lien au propriétaire du serveur.';
    case 'network': return 'Serveur injoignable : réessaie dans un instant.';
    case 'rate_limited': return 'Trop de tentatives.' + (err.retryAfterSec ? ' Réessaie dans ' + err.retryAfterSec + ' s.' : '');
    case 'weak_password': case 'invalid_body': return 'Mot de passe refusé : 8 caractères au moins.';
    default: return 'Erreur (' + err.code + ').';
  }
}

function leave() {
  try { history.replaceState(null, '', (/\/reset-password\/?$/.test(location.pathname) ? location.pathname.replace(/reset-password\/?$/, '') : location.pathname) + '#/'); } catch (_) { /* adresse inchangée */ }
}

/** Affiche la page et attend la fin du parcours. Le jeton disparaît de l'adresse dès l'ouverture. */
export function runResetFlow(token) {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.id = 'reset';
    root.className = 'auth';
    root.innerHTML = '<div class="auth-card" role="main"><div class="auth-brand">' + brand() + '</div><h1 class="auth-title" id="reset-title" tabindex="-1">Nouveau mot de passe</h1>' +
      '<form id="reset-form" class="tv-form auth-form" autocomplete="off" aria-labelledby="reset-title">' +
      '<p class="tv-form-note">Choisis un nouveau mot de passe (8 caractères au moins). Toutes tes sessions seront fermées.</p>' +
      '<label class="tv-field">Nouveau mot de passe<input type="password" name="password" autocomplete="new-password" minlength="8" required></label>' +
      '<label class="tv-field">Confirme le mot de passe<input type="password" name="confirm" autocomplete="new-password" minlength="8" required></label>' +
      '<p class="tv-form-msg" id="reset-msg" role="alert"></p>' +
      '<div class="tv-form-actions"><button type="submit" class="btn btn-primary">Changer le mot de passe</button> <button type="button" class="btn btn-ghost" data-reset-skip>Annuler</button></div></form></div>';
    document.body.appendChild(root);
    document.body.classList.add('modal-open');
    leave();
    const form = root.querySelector('#reset-form');
    const msg = root.querySelector('#reset-msg');
    root.querySelector('#reset-title').focus({ preventScroll: true });
    const finish = () => { root.remove(); document.body.classList.remove('modal-open'); resolve(); };
    root.querySelector('[data-reset-skip]').addEventListener('click', finish);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const issue = passwordIssue(form.elements.password.value, form.elements.confirm.value);
      if (issue) { msg.textContent = issue; return; }
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      msg.textContent = '';
      try {
        await passwordReset(token, form.elements.password.value);
        form.elements.password.value = '';
        form.elements.confirm.value = '';
        form.innerHTML = '<p class="auth-invite-ok" role="status">Mot de passe modifié. Tu peux te connecter avec le nouveau.</p>' +
          '<div class="tv-form-actions"><button type="button" class="btn btn-primary" data-reset-done>Se connecter</button></div>';
        form.querySelector('[data-reset-done]').addEventListener('click', finish);
        form.querySelector('[data-reset-done]').focus();
      } catch (err) {
        msg.textContent = resetError(err);
        btn.disabled = false;
      }
    });
  });
}
