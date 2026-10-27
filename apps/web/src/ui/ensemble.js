/* Page Ensemble (#/ensemble[/<onglet>]) : tout ce qui se regarde à plusieurs. Remplace l'ancienne page Watch parties (#/parties redirige ici).
 * Coque : en-tête (titre, sous-titre, Amis, « Rejoindre avec un code », « Créer un salon »), onglets Maintenant / Ce soir / À venir / Salons publics / Passées.
 * « Maintenant » : salons en direct chez les amis puis salons publics ; « Salons publics » : la liste complète (parties.js). Colonne latérale
 * (ensembleSide.js) : amis disponibles, activité, billets. « Ce soir », « À venir » et « Passées » (eveningsPane.js) : soirées planifiées.
 * Compte connecté hors profil enfant seulement (le routeur renvoie un profil enfant à l'accueil). */
import { canAdmin, isKidProfile, isServerMode } from '../data/auth';
import { parseJoinHash } from '../party/join';
import { detailEl } from './dom.js';
import { mountEnsembleSide } from './ensembleSide.js';
import { ENSEMBLE_TABS, ensembleHash, ensembleTabOf } from './ensembleTabs.js';
import { openEveningForm } from './eveningForm.js';
import { EVENING_TABS, mountEveningsPane } from './eveningsPane.js';
import { teardownFiche } from './fiche.js';
import { brand } from './fragments.js';
import { tabbar } from './home.js';
import { ICON } from './icons.js';
import { mountPartiesPane, openCreateParty } from './parties.js';
import { ensFriendsBadgeHTML, socialAvailable } from './socialButton.js';
import { state } from './state.js';
import { mainNavHTML, topActionsHTML } from './topnav.js';
import { esc } from './util.js';

/** Suffixe des ids des menus de cette barre : la barre de l'accueil (masquée) garde les siens. */
const BAR_ID = '-ens';

const SUBTITLE = 'Tout ce qui se regarde à plusieurs : salons ouverts, soirées planifiées, amis disponibles.';

/**
 * Adresse du salon désigné par la saisie de « Rejoindre avec un code » : lien d'invitation complet (avec ou sans jeton d'invité),
 * `#/party/<id>` ou identifiant seul. Chaîne vide si la saisie n'est pas reconnue.
 * Limite : le serveur n'a pas (encore) de code court distinct de l'identifiant du salon ; seuls l'identifiant et les liens sont acceptés.
 */
export function roomHashOfCode(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  const at = v.indexOf('#/');
  const frag = at >= 0 ? v.slice(at) : '';
  if (frag) return parseJoinHash(frag) || /^#\/party\/[A-Za-z0-9_-]{1,64}$/.test(frag) ? frag : '';
  return /^[A-Za-z0-9_-]{1,64}$/.test(v) ? '#/party/' + v : '';
}

const barHTML = (social) =>
  '<header class="topbar">' + brand() + '<nav class="nav" aria-label="Principale">' + mainNavHTML({ current: 'ensemble', idSuffix: BAR_ID, social }) + '</nav>' +
  topActionsHTML({ social, server: isServerMode(), owner: canAdmin(), idSuffix: BAR_ID }) + '</header>';

const tabsHTML = (tab) =>
  '<nav class="ens-tabs" aria-label="Sections d’Ensemble">' +
  ENSEMBLE_TABS.map(([id, label]) =>
    '<a class="ens-tab' + (id === tab ? ' is-on' : '') + '" href="' + ensembleHash(id) + '" data-go' + (id === tab ? ' aria-current="page"' : '') + '>' + esc(label) + '</a>').join('') + '</nav>';

/** Onglets servis par la liste des salons (parties.js) : identifiant -> mode du panneau. */
const PANES = { maintenant: 'now', 'salons-publics': 'public' };

const JOIN_MSG_ID = 'ens-join-msg';

const headHTML = () =>
  '<header class="ens-head"><div class="ens-head-t"><h1 class="ens-title" id="ens-title" tabindex="-1">Ensemble</h1><p class="ens-sub">' + SUBTITLE + '</p></div>' +
  '<div class="ens-acts"><a class="btn btn-ghost" href="#/friends" data-go>' + ICON.users + 'Amis' + ensFriendsBadgeHTML() + '</a>' +
  '<button type="button" class="btn btn-ghost" data-ens-join aria-expanded="false" aria-controls="ens-join">Rejoindre avec un code</button>' +
  '<button type="button" class="btn btn-ghost" data-ens-plan>' + ICON.calendar + 'Planifier une soirée</button>' +
  '<button type="button" class="btn btn-primary" data-ens-create>' + ICON.plus + 'Créer un salon</button></div></header>' +
  '<form class="ens-join" id="ens-join" data-ens-join-form hidden novalidate>' +
  '<label class="sr-only" for="ens-join-input">Code ou lien d’invitation du salon</label>' +
  '<input id="ens-join-input" class="ens-join-input" type="text" name="code" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Code ou lien d’invitation du salon">' +
  '<button type="submit" class="btn btn-primary">Rejoindre</button>' +
  '<p class="ens-join-msg" id="' + JOIN_MSG_ID + '" data-ens-join-msg role="status"></p></form>';

/** Affiche la page `tab` (identifiant d'onglet ; défaut : Maintenant). */
export function showEnsemble(tab = 'maintenant') {
  teardownFiche();
  state.kind = 'ensemble';
  const current = ensembleTabOf(tab) || 'maintenant';
  document.title = 'Ensemble · Laststream';
  if (!socialAvailable()) {
    // eslint-disable-next-line no-restricted-syntax -- contenu dynamique échappé par esc (nom du profil, libellés)
    detailEl.innerHTML = '<div class="s-a ens-root">' + barHTML(false) + '<article class="svc-page ens-page" aria-labelledby="ens-title">' +
      '<header class="ens-head"><div class="ens-head-t"><h1 class="ens-title" id="ens-title" tabindex="-1">Ensemble</h1></div></header>' +
      '<p class="row-msg" role="status">' + (isKidProfile() ? 'Les salons ne sont pas disponibles sur un profil enfant.' : 'Connecte-toi à un compte Laststream pour regarder à plusieurs.') + '</p></article>' + tabbar() + '</div>';
  } else {
    // eslint-disable-next-line no-restricted-syntax -- contenu dynamique échappé par esc (nom du profil, libellés)
    detailEl.innerHTML = '<div class="s-a ens-root">' + barHTML(true) + '<article class="svc-page ens-page" aria-labelledby="ens-title">' + headHTML() + tabsHTML(current) +
      '<div class="ens-grid"><section class="ens-panel" id="ens-panel" aria-label="' + esc(ENSEMBLE_TABS.find(([id]) => id === current)[1]) + '">' +
      '' + '</section><aside class="ens-side" id="ens-side" aria-label="Amis, activité et billets"></aside></div></article>' + tabbar('ensemble') + '</div>';
    const panel = detailEl.querySelector('#ens-panel');
    if (PANES[current] && panel) mountPartiesPane(panel, PANES[current]);
    else if (EVENING_TABS.includes(current) && panel) mountEveningsPane(panel, current);
    const side = detailEl.querySelector('#ens-side');
    if (side) mountEnsembleSide(side);
  }
  const h1 = detailEl.querySelector('#ens-title');
  if (h1) h1.focus({ preventScroll: true });
}

detailEl.addEventListener('click', (e) => {
  if (state.kind !== 'ensemble') return;
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  if (t.closest('[data-ens-create]')) { e.preventDefault(); openCreateParty(); return; }
  const plan = t.closest('[data-ens-plan]');
  if (plan) { e.preventDefault(); openEveningForm({ opener: plan }); return; }
  const join = t.closest('[data-ens-join]');
  if (join) {
    e.preventDefault();
    const form = detailEl.querySelector('[data-ens-join-form]');
    if (!(form instanceof HTMLElement)) return;
    const open = form.hidden;
    form.hidden = !open;
    join.setAttribute('aria-expanded', String(open));
    const input = form.querySelector('input');
    if (open && input) input.focus({ preventScroll: true });
  }
});

/** Marque (ou démarque) le champ de code : invalide, et décrit par le message d'erreur (JOIN_MSG_ID). */
function markJoinInvalid(input, invalid) {
  if (invalid) {
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', JOIN_MSG_ID);
  } else {
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
  }
}

detailEl.addEventListener('submit', (e) => {
  const form = e.target instanceof Element ? e.target.closest('[data-ens-join-form]') : null;
  if (!form || state.kind !== 'ensemble') return;
  e.preventDefault();
  const input = form.querySelector('input');
  const msg = form.querySelector('[data-ens-join-msg]');
  const hash = roomHashOfCode(input ? input.value : '');
  if (hash) {
    if (msg) msg.textContent = '';
    if (input) markJoinInvalid(input, false);
    location.hash = hash;
  } else {
    if (msg) msg.textContent = 'Code non reconnu : colle le lien d’invitation ou l’identifiant du salon.';
    if (input) {
      markJoinInvalid(input, true);
      input.focus({ preventScroll: true });
    }
  }
});

/** Saisie corrigée : la marque d'erreur et le message tombent. */
detailEl.addEventListener('input', (e) => {
  const input = e.target instanceof HTMLInputElement && e.target.closest('[data-ens-join-form]') ? e.target : null;
  if (!input || state.kind !== 'ensemble' || !input.hasAttribute('aria-invalid') || !roomHashOfCode(input.value)) return;
  markJoinInvalid(input, false);
  const msg = input.closest('[data-ens-join-form]').querySelector('[data-ens-join-msg]');
  if (msg) msg.textContent = '';
});
