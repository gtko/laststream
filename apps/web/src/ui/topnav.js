/* Barre du haut (accueil adulte et enfant) : menu « Explorer », menu du profil, clavier, défilement.
 * Le rendu est fonctionnel : les appelants passent les indicateurs (enfant, amis, propriétaire, serveur). */
import { isKidProfile, isProfileLocked, signOut } from '../data/auth';
import { userStore } from '../data/userStore';
import { avatarAttrs } from './avatar-art.js';
import { leaveKidProfile, openPicker } from './auth-ui.js';
import { ICON } from './icons.js';
import { friendsButtonHTML } from './socialButton.js';
import { downloadsNavHTML } from './downloadBtn.js';
import { esc } from './util.js';

const TOP_DROP = '.topbar [data-drop]';

/** Lien d'un menu : icône + libellé. */
const menuLink = (href, attrs, icon, label) =>
  '<a href="' + href + '"' + attrs + '>' + ICON[icon] + '<span>' + label + '</span></a>';

/** Menu principal : [identifiant, adresse, attributs du lien, icône, libellé]. Les services de streaming restent dans Collections. */
const MAIN_NAV = [
  ['series', '#/series', ' data-go', 'layers', 'Séries'],
  ['films', '#/films', ' data-go', 'film', 'Films'],
  ['direct', '#/tv-live', ' data-tvlive', 'play', 'Direct'],
  ['emissions', '#/emissions', ' data-showsnav', 'tv', 'Émissions TV'],
  ['documentaires', '#/documentaires', ' data-go', 'info', 'Documentaires'],
];

/** Attributs d'état du lien de la page affichée (`current` : identifiant de MAIN_NAV). */
const currentAttrs = (id, current) => (id === current ? ' aria-current="page"' : '');

/** Menu « Explorer » : les entrées hors menu principal ; sous 1100 px, les cinq entrées du menu principal s'y ajoutent (classe nav-pop-compact). */
function exploreMenuHTML(idSuffix, current) {
  const compact = '<ul class="nav-pop-list nav-pop-compact">' +
    MAIN_NAV.map(([id, href, attrs, icon, label]) => '<li>' + menuLink(href, attrs + currentAttrs(id, current), icon, label) + '</li>').join('') + '</ul>';
  const main = '<ul class="nav-pop-list">' +
    '<li>' + menuLink('#/library', ' data-libnav', 'list', 'Ma liste') + '</li>' +
    '<li>' + menuLink('#/collections', ' data-go', 'grid', 'Collections') + '</li>' +
    '<li>' + menuLink('#/discover', ' data-go', 'compass', 'Découvrir') + '</li>' +
    '<li>' + menuLink('#/calendar', ' data-calnav', 'calendar', 'Calendrier') + '</li></ul>';
  return '<div class="nav-drop" data-drop>' +
    '<button type="button" class="nav-drop-btn" data-drop-btn aria-expanded="false" aria-controls="nav-explore' + idSuffix + '">Explorer' + ICON.chev + '</button>' +
    '<div class="nav-pop nav-pop-explore" id="nav-explore' + idSuffix + '" hidden>' + main + compact + '</div></div>';
}

/**
 * Liens de la barre du haut (adulte) : Séries, Films, Direct, Émissions TV, Documentaires, puis le menu « Explorer ».
 * `current` : identifiant de l'entrée de la page affichée (soulignée, aria-current), vide sur l'accueil (le logo y ramène).
 */
export function mainNavHTML({ current = '', idSuffix = '' } = {}) {
  return MAIN_NAV.map(([id, href, attrs, , label]) =>
    '<a href="' + href + '"' + attrs + ' class="nav-wide' + (id === current ? ' is-current' : '') + '"' + currentAttrs(id, current) + '>' + label + '</a>').join('') +
    exploreMenuHTML(idSuffix, current);
}

/** Bouton « Watch parties » (comptes connectés hors profil enfant). */
export const partyLinkHTML = () =>
  '<a class="icon-btn nav-party" href="#/parties" data-go aria-label="Watch parties" title="Watch parties">' + ICON.party + '</a>';

/**
 * Recherche (loupe, ou champ fourni par `search` : page Recherche), Amis et Watch parties (si social), puis l'avatar qui ouvre le menu du profil.
 * kid : profil enfant (seulement « Changer de profil »). social : bouton Amis (barre latérale, pastille) et Watch parties. server : profil de compte (changement, déconnexion). owner : propriétaire du serveur.
 */
export function topActionsHTML({ kid = false, social = false, server = false, owner = false, search = '', idSuffix = '' } = {}) {
  const current = userStore.currentProfile();
  const name = current.name || '?';
  const initial = name.slice(0, 1).toUpperCase();
  const bg = current.avatarColor || current.avatar ? avatarAttrs(current.avatar, current.avatarColor) : '';
  const items = [
    kid ? '' : menuLink('#/stats', ' data-go', 'stats', 'Statistiques'),
    kid ? '' : menuLink('#/settings', ' data-go', 'gear', 'Réglages'),
    owner && !kid ? menuLink('#/admin', ' data-go', 'shield', 'Administration') : '',
    server && !isProfileLocked() ? '<button type="button" class="nav-pop-item" data-nav-switch>' + ICON.switch + '<span>Changer de profil</span></button>' : '',
    server && !kid ? '<button type="button" class="nav-pop-item" data-nav-logout>' + ICON.logout + '<span>Se déconnecter</span></button>' : '',
  ].join('');
  return '<div class="top-actions">' +
    (search || '<button type="button" class="icon-btn" data-search aria-label="Rechercher">' + ICON.search + '</button>') +
    (kid ? '' : downloadsNavHTML()) +
    (social ? friendsButtonHTML('icon-btn') : '') +
    (social ? partyLinkHTML() : '') +
    '<div class="nav-drop nav-drop-profile" data-drop>' +
    '<button type="button" class="avatar nav-avatar" data-drop-btn aria-expanded="false" aria-controls="nav-profile' + idSuffix + '"' + bg +
    ' aria-label="Profil ' + esc(name) + ', menu">' + esc(initial) + '</button>' +
    '<div class="nav-pop nav-pop-profile" id="nav-profile' + idSuffix + '" hidden>' +
    '<div class="nav-pop-who">' + esc(name) + (kid ? '<span class="nav-pop-sub">Profil enfant</span>' : '') + '</div>' +
    items + '</div></div></div>';
}

// ---------- Comportement ----------
const topDrops = () => Array.from(document.querySelectorAll(TOP_DROP));
const panelOf = (drop) => drop.querySelector('.nav-pop');
const triggerOf = (drop) => drop.querySelector('[data-drop-btn]');
const isOpen = (drop) => !panelOf(drop).hidden;
/** Éléments du menu dans l'ordre affiché : les liens d'accès rapide (écrans étroits) sont en tête. */
const itemsOf = (drop) => Array.from(panelOf(drop).querySelectorAll('a[href], button:not([disabled])'))
  .sort((a, b) => Number(!a.closest('.nav-pop-compact')) - Number(!b.closest('.nav-pop-compact')));

function openDrop(drop, focusFirst) {
  closeAll(drop);
  panelOf(drop).hidden = false;
  triggerOf(drop).setAttribute('aria-expanded', 'true');
  if (focusFirst) moveFocus(drop, 1);
}

function closeDrop(drop, returnFocus = false) {
  if (!isOpen(drop)) return;
  panelOf(drop).hidden = true;
  triggerOf(drop).setAttribute('aria-expanded', 'false');
  if (returnFocus) triggerOf(drop).focus();
}

function closeAll(keep = null) {
  topDrops().forEach((d) => { if (d !== keep) closeDrop(d); });
}

/** Flèche haut/bas : passe à l'élément suivant ou précédent du menu (les éléments masqués sont ignorés). */
function moveFocus(drop, dir) {
  const list = itemsOf(drop);
  const n = list.length;
  if (!n) return;
  const cur = list.indexOf(document.activeElement);
  for (let k = 0; k < n; k += 1) {
    const idx = cur < 0 ? (dir > 0 ? k : n - 1 - k) : (((cur + dir * (k + 1)) % n) + n) % n;
    const cand = list[idx];
    cand.focus();
    if (document.activeElement === cand) return;
  }
}

async function onClick(e) {
  const t = e.target;
  if (!(t instanceof Element)) return;
  const trigger = t.closest('.topbar [data-drop-btn]');
  if (trigger) {
    const drop = trigger.closest(TOP_DROP);
    if (isOpen(drop)) closeDrop(drop);
    else openDrop(drop, e.detail === 0); // clavier (Entrée, Espace) : on entre dans le menu
    return;
  }
  const sw = t.closest('[data-nav-switch]');
  if (sw) {
    e.preventDefault();
    closeAll();
    if (isKidProfile()) leaveKidProfile(); else openPicker();
    return;
  }
  const lo = t.closest('[data-nav-logout]');
  if (lo) {
    e.preventDefault();
    closeAll();
    await signOut();
    location.hash = '#/';
    location.reload();
    return;
  }
  if (t.closest('.topbar .nav-pop')) {
    if (t.closest('a')) closeAll(); // un lien ferme le menu ; le reste du menu reste ouvert
    return;
  }
  closeAll();
}

function onKeyDown(e) {
  const open = topDrops().find(isOpen);
  if (!open) {
    const trigger = e.target instanceof Element ? e.target.closest('.topbar [data-drop-btn]') : null;
    if (trigger && e.key === 'ArrowDown') {
      e.preventDefault();
      openDrop(trigger.closest(TOP_DROP), true);
    }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closeDrop(open, true);
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!open.contains(document.activeElement)) return;
    e.preventDefault();
    moveFocus(open, e.key === 'ArrowDown' ? 1 : -1);
  }
}

/** Le focus quitte le menu : on le referme (un clic hors zone est géré par onClick). */
function onFocusOut(e) {
  const open = topDrops().find(isOpen);
  if (!open) return;
  const next = e.relatedTarget;
  if (next instanceof Element && !open.contains(next)) closeDrop(open);
}

/** Fond opaque et flou dès qu'on défile ; transparent tant qu'on est en haut de page. (Plusieurs barres : accueil masqué + page Recherche.) */
export function syncTopbar() {
  const scrolled = window.scrollY > 8;
  document.querySelectorAll('.topbar').forEach((bar) => bar.classList.toggle('is-scrolled', scrolled));
}

let ready = false;
/** Branche les écouteurs une seule fois (menus, clavier, défilement). */
export function initTopnav() {
  if (ready) return;
  ready = true;
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('focusout', onFocusOut);
  window.addEventListener('scroll', syncTopbar, { passive: true });
}

initTopnav();
